class Perspective {
  /**
   * @param {CanvasRenderingContext2D} ctx2d
   * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement} source
   * @param {number} N  — grid dimension (NxN control points)
   */
  constructor(ctx2d, source, N = 4) {
    if (!ctx2d || !source) throw new Error("Perspective: invalid args");

    this.ctx2d   = ctx2d;
    this.source  = source;
    this.N       = N;
    this.dstW    = ctx2d.canvas.width;
    this.dstH    = ctx2d.canvas.height;
    this.srcW    = source.videoWidth  || source.width;
    this.srcH    = source.videoHeight || source.height;

    const { gl, canvas } = this.#createGLContext(this.dstW, this.dstH);
    this.gl       = gl;
    this.glCanvas = canvas;

    this.program = this.#buildProgram(gl, this.#vertSrc(), this.#fragSrc(N));

    // Full-screen quad
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

    // Attribute / uniform locations
    this.loc = {
      pos:        gl.getAttribLocation (this.program, "a_pos"),
      tex:        gl.getUniformLocation(this.program, "u_tex"),
      resolution: gl.getUniformLocation(this.program, "u_resolution"),
      srcSize:    gl.getUniformLocation(this.program, "u_srcSize"),
      N:          gl.getUniformLocation(this.program, "u_N"),
      dstPts:     gl.getUniformLocation(this.program, "u_dstPts"),   // vec2[N*N]
    };

    // Texture
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    gl.viewport(0, 0, this.dstW, this.dstH);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,       gl.ONE_MINUS_SRC_ALPHA
    );
  }

  // -------------------------------------------------------------------------
  /**
   * @param {Array<[number,number]>} dstPoints  — NxN canvas-space coords,
   *   row-major (row 0 = top, col 0 = left).  Length must be N*N.
   */
  draw(dstPoints) {
    const { gl, loc, N } = this;
    const n2 = N * N;

    if (dstPoints.length !== n2)
      throw new Error(`Perspective.draw: expected ${n2} points, got ${dstPoints.length}`);

    // Upload video frame
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);

    // Flatten dstPoints → Float32Array [x0,y0, x1,y1, ...]
    const flat = new Float32Array(n2 * 2);
    for (let i = 0; i < n2; i++) {
      flat[i * 2]     = dstPoints[i][0];
      flat[i * 2 + 1] = dstPoints[i][1];
    }

    gl.useProgram(this.program);
    gl.viewport(0, 0, this.dstW, this.dstH);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(loc.pos);
    gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(loc.tex, 0);
    gl.uniform2f(loc.resolution, this.dstW, this.dstH);
    gl.uniform2f(loc.srcSize, this.srcW, this.srcH);
    gl.uniform1i(loc.N, N);
    gl.uniform2fv(loc.dstPts, flat);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Composite warped GL output onto ctx2d, clipped to grid outline
    const ctx = this.ctx2d;
    ctx.save();
    ctx.beginPath();
    // Outline: top row, right col, bottom row (reversed), left col (reversed)
    const idx = (r, c) => r * N + c;
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

  // =========================================================================
  // GLSL
  // =========================================================================

  #vertSrc() {
    return `
      attribute vec2 a_pos;
      varying   vec2 v_pos;
      void main() {
        v_pos = a_pos;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;
  }

  /**
   * Fragment shader strategy
   * ─────────────────────────
   * The destination grid has (N-1)² cells.  Each cell is a quad defined by
   * four adjacent control points:
   *   TL = dstPts[(row  )*N + col  ]
   *   TR = dstPts[(row  )*N + col+1]
   *   BL = dstPts[(row+1)*N + col  ]
   *   BR = dstPts[(row+1)*N + col+1]
   *
   * For each fragment we iterate over all cells, test whether the pixel
   * lies inside the quad (using the signed-area / cross-product test for
   * convex quads), and once a containing cell is found we solve the
   * bilinear equations for (s, t) ∈ [0,1]² and map those to the
   * corresponding UV in the source texture.
   *
   * The source grid is perfectly regular: cell (row, col) maps to
   *   u = col  / (N-1),   v = row  / (N-1)   (TL corner)
   *   u = (col+1)/(N-1),  v = (row+1)/(N-1)  (BR corner)
   *
   * GLSL loops must have compile-time constant bounds, so we use the
   * maximum supported N (MAX_N) and guard with a runtime check.
   */
#fragSrc(N) {
  const MAX_N = Math.max(N, 2);
  const MAX_N2 = MAX_N * MAX_N;

  // Generate a GLSL function that does a fully unrolled lookup
  // WebGL1: NO dynamic array indexing — every access must be a literal index
  function genCpLookup() {
    const lines = [`vec2 cp(int r, int c) {`];
    for (let row = 0; row < MAX_N; row++) {
      for (let col = 0; col < MAX_N; col++) {
        const idx = row * MAX_N + col;
        const cond = (row === 0 && col === 0)
          ? `if (r==${row} && c==${col})`
          : `else if (r==${row} && c==${col})`;
        lines.push(`  ${cond} return u_dstPts[${idx}];`);
      }
    }
    lines.push(`  return u_dstPts[0];`); // fallback (never reached)
    lines.push(`}`);
    return lines.join('\n');
  }

  // Unrolled bounding box computation over all MAX_N2 points
  function genBboxCompute() {
    const lines = [`vec2 bmin = u_dstPts[0];`, `vec2 bmax = u_dstPts[0];`];
    for (let k = 1; k < MAX_N2; k++) {
      lines.push(`bmin = min(bmin, u_dstPts[${k}]);`);
      lines.push(`bmax = max(bmax, u_dstPts[${k}]);`);
    }
    return lines.join('\n');
  }

  return `
    precision highp float;

    uniform sampler2D u_tex;
    uniform vec2      u_resolution;
    uniform vec2      u_srcSize;
    uniform int       u_N;
    uniform vec2      u_dstPts[${MAX_N2}];

    varying vec2 v_pos;

    ${genCpLookup()}

    // Clamp index to [0, N-1] for clamped boundary behaviour
    int clampIdx(int i, int maxI) {
      return int(clamp(float(i), 0.0, float(maxI)));
    }

    // Safe control point fetch with clamped boundary
    vec2 cpClamped(int row, int col) {
      int N = u_N;
      return cp(clampIdx(row, N-1), clampIdx(col, N-1));
    }

    vec4 cubicWeights(float t) {
      float t2 = t * t;
      float t3 = t2 * t;
      return vec4(
        (-t3 + 3.0*t2 - 3.0*t + 1.0) / 6.0,
        ( 3.0*t3 - 6.0*t2 + 4.0) / 6.0,
        (-3.0*t3 + 3.0*t2 + 3.0*t + 1.0) / 6.0,
        t3 / 6.0
      );
    }

    vec4 cubicWeightsDeriv(float t) {
      float t2 = t * t;
      return vec4(
        (-3.0*t2 + 6.0*t - 3.0) / 6.0,
        ( 9.0*t2 - 12.0*t) / 6.0,
        (-9.0*t2 + 6.0*t + 3.0) / 6.0,
        3.0*t2 / 6.0
      );
    }

    // Evaluate bicubic B-spline. wu/wv select eval vs deriv weights.
    vec2 splineEvalFull(float u, float v, bool derivU, bool derivV) {
      int N = u_N;
      float uf = u * float(N - 1);
      float vf = v * float(N - 1);
      int ui = int(clamp(floor(uf), 0.0, float(N - 2)));
      int vi = int(clamp(floor(vf), 0.0, float(N - 2)));
      float s = uf - float(ui);
      float t = vf - float(vi);

      vec4 wu = derivU ? cubicWeightsDeriv(s) : cubicWeights(s);
      vec4 wv = derivV ? cubicWeightsDeriv(t) : cubicWeights(t);
      float scaleU = derivU ? float(N - 1) : 1.0;
      float scaleV = derivV ? float(N - 1) : 1.0;

      vec2 result = vec2(0.0);
      for (int j = 0; j < 4; j++) {
        vec2 row_sum = vec2(0.0);
        for (int i = 0; i < 4; i++) {
          row_sum += wu[i] * cpClamped(vi + j - 1, ui + i - 1);
        }
        result += wv[j] * row_sum;
      }
      return result * scaleU * scaleV;
    }

    vec2 splineEval  (float u, float v) { return splineEvalFull(u, v, false, false); }
    vec2 splineDerivU(float u, float v) { return splineEvalFull(u, v, true,  false); }
    vec2 splineDerivV(float u, float v) { return splineEvalFull(u, v, false, true ); }

    vec2 splineInverse(vec2 coord) {
      ${genBboxCompute()}
      vec2 uv = clamp((coord - bmin) / (bmax - bmin), 0.01, 0.99);

      for (int iter = 0; iter < 8; iter++) {
        vec2 P   = splineEval(uv.x, uv.y);
        vec2 err = P - coord;
        if (dot(err, err) < 0.01) break;

        vec2 dPdu = splineDerivU(uv.x, uv.y);
        vec2 dPdv = splineDerivV(uv.x, uv.y);

        float det = dPdu.x * dPdv.y - dPdu.y * dPdv.x;
        if (abs(det) < 1e-4) break;

        float du = (-err.x * dPdv.y + err.y * dPdv.x) / det;
        float dv = (-dPdu.x * err.y + dPdu.y * err.x) / det;
        uv = clamp(uv + vec2(du, dv), 0.0, 1.0);
      }
      return uv;
    }

    void main() {
      vec2 coord = gl_FragCoord.xy;
      coord.y = u_resolution.y - coord.y;

      vec2 uv          = splineInverse(coord);
      vec2 reprojected = splineEval(uv.x, uv.y);

      if (length(reprojected - coord) > 2.0) discard;

      gl_FragColor = texture2D(u_tex, uv);
    }
  `;
}

  // =========================================================================
  // WebGL boilerplate
  // =========================================================================

  #createGLContext(w, h) {
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const gl =
      canvas.getContext("webgl", { preserveDrawingBuffer: true }) ||
      canvas.getContext("experimental-webgl", { preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL not supported");
    return { gl, canvas };
  }

  #buildShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error("Shader compile error:\n" + gl.getShaderInfoLog(s));
    return s;
  }

  #buildProgram(gl, vs, fs) {
    const v = this.#buildShader(gl, gl.VERTEX_SHADER, vs);
    const f = this.#buildShader(gl, gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error("Program link error:\n" + gl.getProgramInfoLog(p));
    return p;
  }
}

window.Perspective = Perspective;