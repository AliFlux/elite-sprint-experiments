class Perspective {
  static #LUT = 128;

  constructor(ctx2d, source, N = 4) {
    if (!ctx2d || !source) throw new Error("Perspective: invalid args");

    this.ctx2d  = ctx2d;
    this.source = source;
    this.N      = N;
    this.dstW   = ctx2d.canvas.width;
    this.dstH   = ctx2d.canvas.height;
    this.srcW   = source.videoWidth  || source.width;
    this.srcH   = source.videoHeight || source.height;

    const { gl, canvas } = this.#createGLContext(this.dstW, this.dstH);
    this.gl       = gl;
    this.glCanvas = canvas;

    const extFloat       = gl.getExtension("OES_texture_float");
    const extFloatLinear = gl.getExtension("OES_texture_float_linear");
    const extHalf        = gl.getExtension("OES_texture_half_float");
    const extHalfLinear  = gl.getExtension("OES_texture_half_float_linear");

    if (extFloat && extFloatLinear) {
      this.lutType  = gl.FLOAT;
      this.lutFloat = true;
    } else if (extHalf && extHalfLinear) {
      this.lutType  = extHalf.HALF_FLOAT_OES;
      this.lutFloat = true;
    } else {
      this.lutType  = gl.UNSIGNED_BYTE;
      this.lutFloat = false;
    }

    this.program = this.#buildProgram(gl, this.#vertSrc(), this.#fragSrc());

    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

    this.loc = {
      pos: gl.getAttribLocation (this.program, "a_pos"),
      tex: gl.getUniformLocation(this.program, "u_tex"),
      lut: gl.getUniformLocation(this.program, "u_lut"),
    };

    // video texture
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    // LUT texture
    const L = Perspective.#LUT;
    this.lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const lutPixels = L * L * 4;
    this._lutData = this.lutFloat
      ? new Float32Array(lutPixels)
      : new Uint8Array(lutPixels);

gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, L, L, 0,
  gl.RGBA, this.lutType, null); // allocate ONLY

    gl.viewport(0, 0, this.dstW, this.dstH);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,       gl.ONE_MINUS_SRC_ALPHA
    );
  }

  draw(dstPoints) {
    const { gl, loc, N } = this;
    const n2 = N * N;

    if (dstPoints.length !== n2)
      throw new Error(`Perspective.draw: expected ${n2} points`);

    this.#buildLUT(dstPoints);

    // update video texture (no realloc)
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
gl.texImage2D(
  gl.TEXTURE_2D,
  0,
  gl.RGBA,
  gl.RGBA,
  gl.UNSIGNED_BYTE,
  this.source
);

    gl.useProgram(this.program);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(loc.pos);
    gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(loc.tex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(loc.lut, 1);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // composite
    const ctx = this.ctx2d;
    ctx.save();
    ctx.beginPath();
    const idx = (r, c) => r * N + c;
    ctx.moveTo(dstPoints[idx(0,0)][0], dstPoints[idx(0,0)][1]);
    for (let c=1;c<N;c++) ctx.lineTo(dstPoints[idx(0,c)][0], dstPoints[idx(0,c)][1]);
    for (let r=1;r<N;r++) ctx.lineTo(dstPoints[idx(r,N-1)][0], dstPoints[idx(r,N-1)][1]);
    for (let c=N-2;c>=0;c--) ctx.lineTo(dstPoints[idx(N-1,c)][0], dstPoints[idx(N-1,c)][1]);
    for (let r=N-2;r>=1;r--) ctx.lineTo(dstPoints[idx(r,0)][0], dstPoints[idx(r,0)][1]);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(this.glCanvas, 0, 0);
    ctx.restore();
  }

  #buildLUT(dstPoints) {
    const L = Perspective.#LUT;
    const N = this.N;
    const W = this.dstW;
    const H = this.dstH;
    const dat = this._lutData;
    const gl = this.gl;

    const cr = (t) => {
      const t2=t*t, t3=t2*t;
      return [
        -0.5*t3 + t2 - 0.5*t,
         1.5*t3 - 2.5*t2 + 1,
        -1.5*t3 + 2*t2 + 0.5*t,
         0.5*t3 - 0.5*t2,
      ];
    };
    const crD = (t) => {
      const t2=t*t;
      return [
        -1.5*t2 + 2*t - 0.5,
         4.5*t2 - 5*t,
        -4.5*t2 + 4*t + 0.5,
         1.5*t2 - t,
      ];
    };

    const evalFull = (u,v,cache) => {
      const uf = u*(N-1);
      const vf = v*(N-1);
      const ui = Math.min(uf|0, N-2);
      const vi = Math.min(vf|0, N-2);

      const s = uf-ui;
      const t = vf-vi;

      const wu  = cache.wu  = cr(s);
      const wv  = cache.wv  = cr(t);
      const wuD = cache.wuD = crD(s);
      const wvD = cache.wvD = crD(t);

      let x=0,y=0,dxdu=0,dydu=0,dxdv=0,dydv=0;

      for (let j=0;j<4;j++) {
        let rx=0,ry=0,rdx=0,rdy=0;

        for (let i=0;i<4;i++) {
          const r = vi+j-1;
          const c = ui+i-1;
          const rr = r<0?0:(r>=N?N-1:r);
          const cc = c<0?0:(c>=N?N-1:c);

          const pt = dstPoints[rr*N + cc];

          rx  += wu[i]*pt[0];
          ry  += wu[i]*pt[1];
          rdx += wuD[i]*pt[0];
          rdy += wuD[i]*pt[1];
        }

        x    += wv[j]*rx;
        y    += wv[j]*ry;
        dxdu += wv[j]*rdx;
        dydu += wv[j]*rdy;
        dxdv += wvD[j]*rx;
        dydv += wvD[j]*ry;
      }

      const sc = N-1;
      return [x,y,dxdu*sc,dydu*sc,dxdv*sc,dydv*sc];
    };

    let uRow=0.5, vRow=0.5;
    const cache = {};

    for (let ly=0; ly<L; ly++) {
      let u=uRow, v=vRow;

      for (let lx=0; lx<L; lx++) {
        const cx = (lx/(L-1))*W;
        const cy = (ly/(L-1))*H;

        for (let iter=0; iter<6; iter++) {
          const [x,y,dxdu,dydu,dxdv,dydv] = evalFull(u,v,cache);

          const ex = x-cx, ey = y-cy;
          if ((ex*ex + ey*ey) < 0.0025) break;

          const det = dxdu*dydv - dydu*dxdv;
          if (Math.abs(det) < 1e-9) break;

          u -= ( dydv*ex - dxdv*ey) / det;
          v -= (-dydu*ex + dxdu*ey) / det;

          if (u<0) u=0; else if (u>1) u=1;
          if (v<0) v=0; else if (v>1) v=1;
        }

        const [rx,ry] = evalFull(u,v,cache);
        const residual = Math.abs(rx-cx)+Math.abs(ry-cy);
        const valid = residual < 2.0;

        const base = (ly*L+lx)*4;

        if (this.lutFloat) {
          dat[base]=valid?u:0;
          dat[base+1]=valid?v:0;
          dat[base+2]=valid?residual:0;
          dat[base+3]=valid?1:0;
        } else {
          dat[base]=valid?(u*255)|0:0;
          dat[base+1]=valid?(v*255)|0:0;
          dat[base+2]=valid?Math.min(255,(residual*127)|0):0;
          dat[base+3]=valid?255:0;
        }
      }

      uRow = u;
      vRow = v;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,L,L,gl.RGBA,this.lutType,dat);
  }

  #vertSrc() {
    return `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos,0.0,1.0);
      }
    `;
  }

  #fragSrc() {
    return `
      precision mediump float;
      uniform sampler2D u_tex;
      uniform sampler2D u_lut;
      varying vec2 v_uv;

      void main() {
        vec4 lut = texture2D(u_lut, vec2(v_uv.x, 1.0 - v_uv.y));
        if (lut.a < 0.5) discard;

        float residual = lut.b * 2.0;
        float edge = 1.0 - smoothstep(0.5, 2.0, residual);

        vec4 color = texture2D(u_tex, lut.rg);
        color.a *= edge;
        gl_FragColor = color;
        // gl_FragColor = vec4(lut.rg, 0.0, 1.0);
      }
    `;
  }

  #createGLContext(w,h) {
    const canvas = document.createElement("canvas");
    canvas.width=w; canvas.height=h;
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) throw new Error("WebGL not supported");
    return { gl, canvas };
  }

  #buildShader(gl,type,src) {
    const s = gl.createShader(type);
    gl.shaderSource(s,src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s,gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  #buildProgram(gl,vs,fs) {
    const v=this.#buildShader(gl,gl.VERTEX_SHADER,vs);
    const f=this.#buildShader(gl,gl.FRAGMENT_SHADER,fs);
    const p=gl.createProgram();
    gl.attachShader(p,v);
    gl.attachShader(p,f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p,gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
}

window.Perspective = Perspective;