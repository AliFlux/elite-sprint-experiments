class Perspective {
  static #W_LUT = 256;
  static #H_LUT = 256;

  constructor(ctx2d, source, N = 4) {
    if (!ctx2d || !source) throw new Error("Perspective: invalid args");

    this.ctx2d  = ctx2d;
    this.source = source;
    this.N      = N;
    this.M      = N - 1;
    this.dstW   = ctx2d.canvas.width;
    this.dstH   = ctx2d.canvas.height;
    this.srcW   = source.videoWidth  || source.width;
    this.srcH   = source.videoHeight || source.height;

    const { gl, canvas } = this._createGLContext(this.dstW, this.dstH);
    this.gl       = gl;
    this.glCanvas = canvas;

    const extF  = gl.getExtension("OES_texture_float");
    const extFL = gl.getExtension("OES_texture_float_linear");
    const extH  = gl.getExtension("OES_texture_half_float");
    const extHL = gl.getExtension("OES_texture_half_float_linear");

    if (extF && extFL) {
      this._lutType  = gl.FLOAT;
      this._lutFloat = true;
    } else if (extH && extHL) {
      this._lutType  = extH.HALF_FLOAT_OES;
      this._lutFloat = true;
    } else {
      this._lutType  = gl.UNSIGNED_BYTE;
      this._lutFloat = false;
    }

    this._program = this._buildProgram(gl, this._vertSrc(), this._fragSrc());

    this._vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1,  1, -1,  -1, 1,  1, 1]), gl.STATIC_DRAW);

    this._loc = {
      pos: gl.getAttribLocation (this._program, "a_pos"),
      tex: gl.getUniformLocation(this._program, "u_tex"),
      lut: gl.getUniformLocation(this._program, "u_lut"),
    };

    this._texVideo = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._texVideo);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    const WL = Perspective.#W_LUT;
    const HL = Perspective.#H_LUT;
    this._texLUT = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._texLUT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, WL, HL, 0,
                  gl.RGBA, this._lutType, null);

    this._lutData = this._lutFloat
      ? new Float32Array(WL * HL * 4)
      : new Uint8Array(WL * HL * 4);

    gl.viewport(0, 0, this.dstW, this.dstH);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,       gl.ONE_MINUS_SRC_ALPHA);
  }

  draw(dstPoints) {
    const n2 = this.N * this.N;
    if (dstPoints.length !== n2)
      throw new Error(`Perspective.draw: expected ${n2} points, got ${dstPoints.length}`);

    this._buildLUT(dstPoints);

    const { gl, _loc: loc } = this;

    gl.bindTexture(gl.TEXTURE_2D, this._texVideo);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);

    gl.useProgram(this._program);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.enableVertexAttribArray(loc.pos);
    gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texVideo);
    gl.uniform1i(loc.tex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._texLUT);
    gl.uniform1i(loc.lut, 1);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const ctx = this.ctx2d;
    const N   = this.N;
    const idx = (r, c) => r * N + c;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dstPoints[idx(0, 0)][0], dstPoints[idx(0, 0)][1]);
    for (let c = 1; c < N; c++)
      ctx.lineTo(dstPoints[idx(0, c)][0], dstPoints[idx(0, c)][1]);
    for (let r = 1; r < N; r++)
      ctx.lineTo(dstPoints[idx(r, N-1)][0], dstPoints[idx(r, N-1)][1]);
    for (let c = N-2; c >= 0; c--)
      ctx.lineTo(dstPoints[idx(N-1, c)][0], dstPoints[idx(N-1, c)][1]);
    for (let r = N-2; r >= 1; r--)
      ctx.lineTo(dstPoints[idx(r, 0)][0], dstPoints[idx(r, 0)][1]);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(this.glCanvas, 0, 0);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // LUT construction
  // ---------------------------------------------------------------------------

  _buildLUT(dstPoints) {
    const WL = Perspective.#W_LUT;
    const HL = Perspective.#H_LUT;
    const W  = this.dstW;
    const H  = this.dstH;
    const M  = this.M;
    const N  = this.N;
    const dat = this._lutData;
    const gl  = this.gl;

    const s = 1 / M;

    const invHoms = new Array(M * M);
    const tileBB  = new Array(M * M);

    for (let tj = 0; tj < M; tj++) {
      for (let ti = 0; ti < M; ti++) {
        const k = tj * M + ti;

        const tl = dstPoints[ tj      * N + ti    ];
        const tr = dstPoints[ tj      * N + ti + 1];
        const bl = dstPoints[(tj + 1) * N + ti    ];
        const br = dstPoints[(tj + 1) * N + ti + 1];

        const u0 = ti       * s,  v0 = tj       * s;
        const u1 = (ti + 1) * s,  v1 = (tj + 1) * s;

        // H maps: dst corner → src UV
        // tl→(u0,v0), tr→(u1,v0), br→(u1,v1), bl→(u0,v1)
        invHoms[k] = this._homographyFromQuad(
          tl[0], tl[1],  u0, v0,
          tr[0], tr[1],  u1, v0,
          br[0], br[1],  u1, v1,
          bl[0], bl[1],  u0, v1
        );

        tileBB[k] = {
          minX: Math.min(tl[0], tr[0], bl[0], br[0]),
          maxX: Math.max(tl[0], tr[0], bl[0], br[0]),
          minY: Math.min(tl[1], tr[1], bl[1], br[1]),
          maxY: Math.max(tl[1], tr[1], bl[1], br[1]),
          tl, tr, bl, br,
          u0, v0, u1, v1,
        };
      }
    }

    for (let ly = 0; ly < HL; ly++) {
      const cy = (ly / (HL - 1)) * H;

      for (let lx = 0; lx < WL; lx++) {
        const cx = (lx / (WL - 1)) * W;

        let srcU = 0, srcV = 0, found = false;

        for (let k = 0; k < M * M && !found; k++) {
          const bb = tileBB[k];

          if (cx < bb.minX || cx > bb.maxX || cy < bb.minY || cy > bb.maxY)
            continue;

          if (!this._pointInQuad(cx, cy, bb.tl, bb.tr, bb.br, bb.bl))
            continue;

          const h = invHoms[k];
          const w = h[6]*cx + h[7]*cy + h[8];
          srcU = (h[0]*cx + h[1]*cy + h[2]) / w;
          srcV = (h[3]*cx + h[4]*cy + h[5]) / w;

          srcU = Math.max(bb.u0, Math.min(bb.u1, srcU));
          srcV = Math.max(bb.v0, Math.min(bb.v1, srcV));

          found = true;
        }

        const base = (ly * WL + lx) * 4;
        if (found) {
          if (this._lutFloat) {
            dat[base    ] = srcU;
            dat[base + 1] = srcV;
            dat[base + 2] = 0;
            dat[base + 3] = 1;
          } else {
            dat[base    ] = (srcU * 255 + 0.5) | 0;
            dat[base + 1] = (srcV * 255 + 0.5) | 0;
            dat[base + 2] = 0;
            dat[base + 3] = 255;
          }
        } else {
          dat[base] = dat[base+1] = dat[base+2] = dat[base+3] = 0;
        }
      }
    }

    gl.bindTexture(gl.TEXTURE_2D, this._texLUT);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WL, HL,
                     gl.RGBA, this._lutType, dat);
  }

  // ---------------------------------------------------------------------------
  // Homography solver — 8×8 Gaussian elimination, no SVD
  // ---------------------------------------------------------------------------

  /**
   * Compute H (3×3, row-major Float64Array) mapping:
   *   (x0,y0)→(u0,v0), (x1,y1)→(u1,v1),
   *   (x2,y2)→(u2,v2), (x3,y3)→(u3,v3)
   *
   * Uses the normalised DLT formulation with h8=1, solved by Gaussian
   * elimination with partial pivoting.
   */
  _homographyFromQuad(
    x0, y0, u0, v0,
    x1, y1, u1, v1,
    x2, y2, u2, v2,
    x3, y3, u3, v3
  ) {
    const xs = [x0, x1, x2, x3];
    const ys = [y0, y1, y2, y3];
    const us = [u0, u1, u2, u3];
    const vs = [v0, v1, v2, v3];

    // 8×8 system (h8 = 1, so ui and vi move to RHS)
    const A = new Float64Array(64);
    const b = new Float64Array(8);

    for (let i = 0; i < 4; i++) {
      const x = xs[i], y = ys[i], u = us[i], v = vs[i];

      // Row 2i:   [x, y, 1, 0, 0, 0, -u*x, -u*y] · h = u
      const r0 = 2 * i * 8;
      A[r0+0]=x;  A[r0+1]=y;  A[r0+2]=1;
      A[r0+3]=0;  A[r0+4]=0;  A[r0+5]=0;
      A[r0+6]=-u*x; A[r0+7]=-u*y;
      b[2*i] = u;

      // Row 2i+1: [0, 0, 0, x, y, 1, -v*x, -v*y] · h = v
      const r1 = (2*i + 1) * 8;
      A[r1+0]=0;  A[r1+1]=0;  A[r1+2]=0;
      A[r1+3]=x;  A[r1+4]=y;  A[r1+5]=1;
      A[r1+6]=-v*x; A[r1+7]=-v*y;
      b[2*i+1] = v;
    }

    const h = this._gaussianElim(A, b, 8);

    const H = new Float64Array(9);
    for (let i = 0; i < 8; i++) H[i] = h[i];
    H[8] = 1;
    return H;
  }

  /**
   * Solve the n×n system Ax=b via Gaussian elimination with partial pivoting.
   * Modifies A and b in place. Returns Float64Array(n).
   */
  _gaussianElim(A, b, n) {
    for (let col = 0; col < n; col++) {
      // Partial pivot
      let maxVal = Math.abs(A[col*n + col]);
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        const v = Math.abs(A[row*n + col]);
        if (v > maxVal) { maxVal = v; maxRow = row; }
      }
      if (maxRow !== col) {
        for (let j = 0; j < n; j++) {
          let tmp = A[col*n+j]; A[col*n+j] = A[maxRow*n+j]; A[maxRow*n+j] = tmp;
        }
        let tmp = b[col]; b[col] = b[maxRow]; b[maxRow] = tmp;
      }

      const pivot = A[col*n + col];
      if (Math.abs(pivot) < 1e-14) continue;

      for (let row = col + 1; row < n; row++) {
        const f = A[row*n + col] / pivot;
        for (let j = col; j < n; j++) A[row*n+j] -= f * A[col*n+j];
        b[row] -= f * b[col];
      }
    }

    const x = new Float64Array(n);
    for (let row = n - 1; row >= 0; row--) {
      let sum = b[row];
      for (let j = row + 1; j < n; j++) sum -= A[row*n+j] * x[j];
      x[row] = Math.abs(A[row*n+row]) > 1e-14 ? sum / A[row*n+row] : 0;
    }
    return x;
  }

  // ---------------------------------------------------------------------------
  // Geometry helpers
  // ---------------------------------------------------------------------------

  /**
   * Point-in-quad via signed cross products. Vertices in consistent winding.
   */
  _pointInQuad(px, py, tl, tr, br, bl) {
    const verts = [tl, tr, br, bl];
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const ax = verts[i][0],        ay = verts[i][1];
      const bx = verts[(i+1)%4][0],  by = verts[(i+1)%4][1];
      const cross = (bx - ax)*(py - ay) - (by - ay)*(px - ax);
      if (Math.abs(cross) < 1e-9) continue;
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // GLSL shaders
  // ---------------------------------------------------------------------------

  _vertSrc() {
    return `
      attribute vec2 a_pos;
      varying   vec2 v_uv;
      void main() {
        v_uv        = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;
  }

  _fragSrc() {
    return `
      precision mediump float;
      uniform sampler2D u_tex;
      uniform sampler2D u_lut;
      varying vec2 v_uv;

      void main() {
        // LUT was written top-down (ly=0 = screen top = GL y=1), so flip Y.
        vec4 lut = texture2D(u_lut, vec2(v_uv.x, 1.0 - v_uv.y));
        if (lut.a < 0.5) discard;
        gl_FragColor = texture2D(u_tex, lut.rg);
      }
    `;
  }

  // ---------------------------------------------------------------------------
  // WebGL helpers
  // ---------------------------------------------------------------------------

  _createGLContext(w, h) {
    const canvas = document.createElement("canvas");
    canvas.width  = w;
    canvas.height = h;
    const gl = canvas.getContext("webgl") ||
               canvas.getContext("experimental-webgl");
    if (!gl) throw new Error("WebGL not supported");
    return { gl, canvas };
  }

  _buildShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  _buildProgram(gl, vs, fs) {
    const v = this._buildShader(gl, gl.VERTEX_SHADER,   vs);
    const f = this._buildShader(gl, gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
}

window.Perspective = Perspective;