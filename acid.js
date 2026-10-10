function clip(x) {
  if (x < -3) return -1;
  if (x >  3) return  1;
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}

function blep(t, dt) {
  if (t < dt)      { const u = t / dt;       return u + u - u * u - 1; }
  if (t > 1 - dt)  { const u = (t - 1) / dt; return u * u + u + u + 1; }
  return 0;
}

const DEG = [0, 3, 5, 7, 10, 12, 15, 10];

class Acid extends AudioWorkletProcessor {
  constructor () {
    super();
    this.sr = sampleRate;

    this.tgt = { cut: 420, res: 0.64, env: 0.55, dec: 0.38, acc: 0.6, bpm: 132 };
    this.cur = { cut: 420, res: 0.64, env: 0.55, dec: 0.38, acc: 0.6 };

    this.running = true;
    this.autoMut = true;
    this.wave    = 0;

    this.stepLen = 1;
    this.stepPos = 1e9;
    this.step    = -1;
    this.loops   = 0;

    this.phase  = 0;
    this.freq   = 55;
    this.target = 55;
    this.glide  = 1;

    this.fenv = 0;
    this.aenv = 0;
    this.acc  = 0;

    this.z1 = 0; this.z2 = 0; this.z3 = 0;
    this.dcX = 0; this.dcY = 0;

    this.tick = 0;
    this.dirty = true;

    this.tempo();
    this.fresh();

    this.port.onmessage = (ev) => {
      const d = ev.data;
      switch (d.t) {
        case 'p':    this.tgt[d.k] = d.v; if (d.k === 'bpm') this.tempo(); break;
        case 'new':  this.fresh(); break;
        case 'wave': this.wave = d.v; break;
        case 'run':  this.running = d.v; break;
        case 'mut':  this.autoMut = d.v; break;
      }
    };
  }

  tempo () {
    this.stepLen = Math.max(32, Math.round(this.sr * 15 / this.tgt.bpm));
  }

  pick () {
    return DEG[(Math.random() * DEG.length) | 0] + (Math.random() < 0.2 ? 12 : 0);
  }

  fresh () {
    const p = [];
    for (let i = 0; i < 16; i++) {
      const on = Math.random() < 0.76;
      p.push({
        on,
        n:   this.pick(),
        a:   on && Math.random() < 0.26,
        s:   on && Math.random() < 0.24
      });
    }
    p[0].on = true; p[0].a = true; p[0].s = false; p[0].n = 0;
    this.pat = p;
    this.loops = 0;
    this.dirty = true;
  }

  nudge () {
    const n = 1 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const s = this.pat[1 + ((Math.random() * 15) | 0)];
      const r = Math.random();
      if      (r < 0.44) s.n = this.pick();
      else if (r < 0.70) s.on = !s.on;
      else if (r < 0.88) s.a = !s.a;
      else               s.s = !s.s;
      if (!s.on) { s.a = false; s.s = false; }
    }
    this.dirty = true;
  }

  advance () {
    this.step = (this.step + 1) & 15;
    if (this.step === 0) {
      this.loops++;
      if (this.autoMut && this.loops % 4 === 0) this.nudge();
    }
    const s = this.pat[this.step];
    if (!s.on) return;

    this.target = 55 * Math.pow(2, s.n / 12);
    if (s.s) {
      this.glide = 1 - Math.exp(-1 / (0.05 * this.sr));
    } else {
      this.freq  = this.target;
      this.glide = 1;
      this.fenv  = 1;
      this.aenv  = 1;
    }
    this.acc = s.a ? 1 : 0;
  }

  process (_in, out) {
    const ch = out[0][0];
    if (!ch) return true;

    const c = this.cur, t = this.tgt, sm = 0.1;
    c.cut *= Math.pow(t.cut / c.cut, sm);
    c.res += (t.res - c.res) * sm;
    c.env += (t.env - c.env) * sm;
    c.dec += (t.dec - c.dec) * sm;
    c.acc += (t.acc - c.acc) * sm;

    const decT = 0.035 * Math.pow(1.5 / 0.035, c.dec);
    const fD   = Math.exp(-1 / (decT * this.sr));
    const aD   = Math.exp(-1 / (Math.min(decT * 1.35, 0.62) * this.sr));
    const nyq  = this.sr * 0.47;

    let lastFc = c.cut;

    for (let i = 0; i < ch.length; i++) {
      if (this.running && ++this.stepPos >= this.stepLen) {
        this.stepPos = 0;
        this.advance();
      }

      this.freq += (this.target - this.freq) * this.glide;
      this.fenv *= fD;
      this.aenv *= aD;

      const dt = this.freq / this.sr;
      this.phase += dt;
      if (this.phase >= 1) this.phase -= 1;

      let osc;
      if (this.wave === 0) {
        osc = 2 * this.phase - 1 - blep(this.phase, dt);
      } else {
        let q = this.phase + 0.5; if (q >= 1) q -= 1;
        osc = (this.phase < 0.5 ? 1 : -1) - blep(this.phase, dt) + blep(q, dt);
      }

      const aA  = this.acc * c.acc;
      const eA  = (c.env + aA * 0.55) * this.fenv;
      let   fc  = c.cut * Math.pow(2, eA * 4.2);
      if (fc < 28)  fc = 28;
      if (fc > nyq) fc = nyq;
      lastFc = fc;

      const g  = Math.tan(Math.PI * fc / this.sr);
      const G  = g / (1 + g);
      const iv = 1 / (1 + g);
      const k  = c.res * 8.7 * (1 + aA * 0.22);

      const S  = iv * (G * G * this.z1 + G * this.z2 + this.z3);
      let   u  = (osc * (0.9 + aA * 0.85) - k * S) / (1 + k * G * G * G);
      u = clip(u * 1.5);

      const v1 = (u  - this.z1) * G; const y1 = v1 + this.z1; this.z1 = y1 + v1;
      const v2 = (y1 - this.z2) * G; const y2 = v2 + this.z2; this.z2 = y2 + v2;
      const v3 = (y2 - this.z3) * G; const y3 = v3 + this.z3; this.z3 = y3 + v3;

      /* a ladder loses its bottom end as k rises; claw some back so that
         turning resonance up screams instead of just going quiet */
      let o = y3 * (1 + k * 0.25) * this.aenv * (0.5 + aA * 0.45);

      const hp = o - this.dcX + 0.9985 * this.dcY;
      this.dcX = o; this.dcY = hp;

      ch[i] = clip(hp * 1.15) * 0.72;
    }

    if ((++this.tick & 7) === 0) {
      var msg = { s: this.step, f: lastFc, e: this.fenv, a: this.acc };
      if (this.dirty) { msg.p = this.pat; this.dirty = false; }
      this.port.postMessage(msg);
    }
    return true;
  }
}

registerProcessor('acid', Acid);
