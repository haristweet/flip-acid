/*
 * flip-acid — voice
 *
 * 303 一声ぶんを丸ごと AudioWorklet の中に入れてある。
 * オシレータ・シーケンサ・エンベロープ・フィルタが全部ここにいるので、
 * setInterval のゆらぎがタイミングに乗らない。
 *
 * 内部は 2 倍オーバーサンプリングで走らせて、最後に 4 次で落として戻す。
 * tanh を 2 箇所（フィードバック経路と後段サチュレーション）に置いている以上、
 * 素の 48k で回すと折り返しが可聴域に刺さる。
 */

const OS = 2;

/* ---- RBJ lowpass（デシメータ用） ---- */
class Biquad {
  constructor(fs, f0, q) {
    const w = 2 * Math.PI * f0 / fs;
    const a = Math.sin(w) / (2 * q), c = Math.cos(w);
    const b0 = (1 - c) / 2, b1 = 1 - c, b2 = (1 - c) / 2;
    const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
            - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/*
 * ラダー。1 極を 4 段重ねて、4 段目を帰還に使い、出力は 3 段目から取る。
 * 18dB/oct でありながら 4 極ぶんの共振が乗るのが 303 の効きかたで、
 * BiquadFilter の 12dB/oct とはここが決定的に違う。
 * 帰還に tanh を噛ませてあるので、k を上げると自己発振しつつ低域が痩せる。
 */
class Ladder {
  constructor() { this.s = [0, 0, 0, 0]; this.z = 0; }
  run(x, g, k) {
    const G = g / (1 + g);
    let y = Math.tanh(x - k * this.z), v, out3 = 0;
    for (let i = 0; i < 4; i++) {
      v = (y - this.s[i]) * G;
      y = v + this.s[i];
      this.s[i] = y + v;
      if (i === 2) out3 = y;
    }
    this.z = y;
    return out3;
  }
}

class AcidVoice extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const init = (options && options.processorOptions) || {};
    this.fs = sampleRate * OS;

    this.ladder = new Ladder();
    this.dec1 = new Biquad(this.fs, sampleRate * 0.42, 0.5412);
    this.dec2 = new Biquad(this.fs, sampleRate * 0.42, 1.3066);

    /* ノブ（0..1 正規化、cutoff だけ Hz） */
    this.pCut = init.cutoff || 900; this.pReso = init.reso || 0.35;
    this.pEnv = init.envmod || 0.55; this.pDec = init.decay || 0.35;
    this.cut = this.pCut; this.reso = this.pReso;  /* 平滑後 */

    this.bpm = 138;
    this.running = !!init.run;
    this.steps = init.steps || [];
    this.perfAcc = false; this.perfSld = false;

    this.phase = 0; this.freq = 55; this.target = 55;
    this.step = -1; this.loops = 0; this.acc = 0;
    this.ef = 0; this.ea = 0; this.vca = 0;
    this.gate = false; this.sliding = false;
    this.blocks = 0;
    this.dcX = 0; this.dcY = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'params') {
        this.pCut = m.cutoff; this.pReso = m.reso;
        this.pEnv = m.envmod; this.pDec = m.decay;
      } else if (m.type === 'pattern') {
        this.steps = m.steps;
      } else if (m.type === 'perf') {
        this.perfAcc = m.accent; this.perfSld = m.slide;
      } else if (m.type === 'run') {
        this.running = m.on;
        if (m.on) { this.step = -1; this.acc = 0; this.loops = 0; }
        else { this.gate = false; }
      } else if (m.type === 'tempo') {
        this.bpm = m.bpm;
      }
    };
  }

  nextStep() {
    if (!this.steps.length) return;
    const i = (this.step + 1) % this.steps.length;
    if (i === 0 && this.step >= 0) this.loops++;
    this.step = i;
    const s = this.steps[i];
    const wasSliding = this.sliding;

    this.port.postMessage({ type: 'tick', step: i, loops: this.loops });

    if (!s.on) { this.gate = false; this.sliding = false; return; }

    const accent = s.acc || this.perfAcc;
    this.target = 440 * Math.pow(2, (s.note - 69) / 12);
    if (!wasSliding) this.freq = this.target;   /* 前が slide でなければ跳ぶ */

    /* slide 中は VCA を切らずに繋ぐ。フィルタ側だけアクセントで叩き直す */
    if (!wasSliding || accent) {
      this.ef = 1;
      if (accent) this.ea = 1;
    }
    this.gate = true;
    this.level = accent ? 1.0 : 0.62;
    this.sliding = !!(s.sld || this.perfSld);
  }

  process(_in, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const fs = this.fs;

    const spStep = fs * 60 / this.bpm / 4;
    const smooth = 1 - Math.exp(-1 / (0.008 * fs));
    const decSec = 0.03 * Math.pow(2000 / 30, this.pDec);
    const kEf = Math.exp(-1 / (decSec * fs));
    const kEa = Math.exp(-1 / (0.18 * fs));
    const kAtk = 1 - Math.exp(-1 / (0.002 * fs));
    const kRel = 1 - Math.exp(-1 / (0.008 * fs));
    const kSld = 1 - Math.exp(-1 / (0.055 * fs));
    const FC_MAX = Math.min(fs * 0.16, 16000);
    const kk = this.pReso * 4.4;
    const envOct = this.pEnv * 4.5;

    for (let n = 0; n < out.length; n++) {
      let sum = 0;

      for (let o = 0; o < OS; o++) {
        if (this.running) {
          this.acc += 1;
          if (this.acc >= spStep) { this.acc -= spStep; this.nextStep(); }
        }

        this.cut += (this.pCut - this.cut) * smooth;
        this.reso += (kk - this.reso) * smooth;

        this.ef *= kEf; this.ea *= kEa;
        this.freq += (this.target - this.freq) * (this.sliding ? kSld : 1);
        const tgt = this.gate ? this.level : 0;
        this.vca += (tgt - this.vca) * (tgt > this.vca ? kAtk : kRel);

        /* polyBLEP saw */
        const dt = this.freq / fs;
        this.phase += dt;
        if (this.phase >= 1) this.phase -= 1;
        let t = this.phase, x = 2 * t - 1;
        if (t < dt) { const u = t / dt; x -= u + u - u * u - 1; }
        else if (t > 1 - dt) { const u = (t - 1) / dt; x -= u * u + u + u + 1; }

        x *= this.vca;

        const fc = Math.min(
          Math.max(this.cut * Math.pow(2, envOct * this.ef + 2.2 * this.ea), 30),
          FC_MAX
        );
        const g = Math.tan(Math.PI * fc / fs);

        /* 共振で抜ける低域を少しだけ戻す。全部戻すと 303 に聞こえない */
        let y = this.ladder.run(x * (1 + this.reso * 0.22), g, this.reso);
        y = Math.tanh(y * 2.1) * 0.62;

        y = this.dec2.run(this.dec1.run(y));
        const hp = y - this.dcX + 0.9995 * this.dcY;   /* DC blocker */
        this.dcX = y; this.dcY = hp;
        sum = hp;
      }

      out[n] = sum;
    }

    if ((this.blocks++ & 7) === 0) {
      this.port.postMessage({ type: 'env', ef: this.ef, cut: this.cut, k: this.reso });
    }
    return true;
  }
}

registerProcessor('acid-voice', AcidVoice);
