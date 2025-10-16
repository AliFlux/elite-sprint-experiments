// ---------------------------------------------------------------------------
// Perspective.js
// Hardware-accelerated perspective warp using raw WebGL (no libraries)
// Supports both images and videos.
// ---------------------------------------------------------------------------

class Perspective {
  constructor(ctx2d, source) {
    if (!ctx2d || !source) throw new Error('Perspective: invalid arguments');

    // Store rendering context and dimensions
    const imgW = source.videoWidth || source.width;
    const imgH = source.videoHeight || source.height;

    this.ctx2d = ctx2d;
    this.source = source;
    this.dstW = ctx2d.canvas.width;
    this.dstH = ctx2d.canvas.height;
    this.srcW = imgW;
    this.srcH = imgH;

    // Initialize WebGL
    const { gl, canvas } = this.#createGLContext(this.dstW, this.dstH);
    this.gl = gl;
    this.glCanvas = canvas;

    // Compile shaders and program
    this.program = this.#createProgram(gl, this.#vertexShaderSource(), this.#fragmentShaderSource());

    // Quad covering full viewport
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,  1, 1
    ]), gl.STATIC_DRAW);

    // Shader locations
    this.a_pos = gl.getAttribLocation(this.program, 'a_pos');
    this.u_tex = gl.getUniformLocation(this.program, 'u_tex');
    this.u_invH = gl.getUniformLocation(this.program, 'u_invH');
    this.u_resolution = gl.getUniformLocation(this.program, 'u_resolution');
    this.u_srcSize = gl.getUniformLocation(this.program, 'u_srcSize');

    // Create texture
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Upload initial frame
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    gl.viewport(0, 0, this.dstW, this.dstH);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  // ---------------------------------------------------------------------------
  // Public draw method
  // ---------------------------------------------------------------------------
  draw(points) {
    const gl = this.gl;
    const dst = points.map(([x, y]) => [x, y]);
    const src = [
      [0, 0],
      [this.srcW, 0],
      [this.srcW, this.srcH],
      [0, this.srcH]
    ];

    // Update texture each frame (for video)
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);

    // Compute inverse homography
    const H = this.#computeHomography(src, dst);
    const invH = this.#invert3x3(H);

    // Render to WebGL
    gl.useProgram(this.program);
    gl.viewport(0, 0, this.dstW, this.dstH);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(this.a_pos);
    gl.vertexAttribPointer(this.a_pos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.u_tex, 0);
    gl.uniformMatrix3fv(this.u_invH, false, this.#mat3ToGL(invH));
    gl.uniform2f(this.u_resolution, this.dstW, this.dstH);
    gl.uniform2f(this.u_srcSize, this.srcW, this.srcH);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Composite result to target 2D canvas
    const ctx = this.ctx2d;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dst[0][0], dst[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(dst[i][0], dst[i][1]);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(this.glCanvas, 0, 0);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Private helper methods
  // ---------------------------------------------------------------------------

  #createGLContext(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true }) ||
               canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL not supported');
    return { gl, canvas };
  }

  #createShader(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error('Shader error: ' + gl.getShaderInfoLog(shader));
    return shader;
  }

  #createProgram(gl, vs, fs) {
    const v = this.#createShader(gl, gl.VERTEX_SHADER, vs);
    const f = this.#createShader(gl, gl.FRAGMENT_SHADER, fs);
    const prog = gl.createProgram();
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
    return prog;
  }

  // ---------------------------------------------------------------------------
  // Homography math utilities
  // ---------------------------------------------------------------------------

  #computeHomography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [xs, ys] = src[i];
      const [xd, yd] = dst[i];
      A.push([xs, ys, 1, 0, 0, 0, -xs * xd, -ys * xd]);
      b.push(xd);
      A.push([0, 0, 0, xs, ys, 1, -xs * yd, -ys * yd]);
      b.push(yd);
    }
    const h = this.#solveLinear(A, b);
    return [
      [h[0], h[1], h[2]],
      [h[3], h[4], h[5]],
      [h[6], h[7], 1]
    ];
  }

  #solveLinear(A, b) {
    const n = A.length;
    const M = A.map((row, i) => [...row, b[i]]);
    const eps = 1e-12;

    for (let i = 0; i < n; i++) {
      // Pivot
      let maxRow = i;
      for (let r = i + 1; r < n; r++)
        if (Math.abs(M[r][i]) > Math.abs(M[maxRow][i])) maxRow = r;
      [M[i], M[maxRow]] = [M[maxRow], M[i]];
      if (Math.abs(M[i][i]) < eps) throw new Error('Singular matrix');

      // Normalize
      const diag = M[i][i];
      for (let j = i; j <= n; j++) M[i][j] /= diag;

      // Eliminate
      for (let r = 0; r < n; r++) {
        if (r === i) continue;
        const f = M[r][i];
        for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
      }
    }
    return M.map(row => row[n]);
  }

  #invert3x3(m) {
    const a = m[0][0], b = m[0][1], c = m[0][2];
    const d = m[1][0], e = m[1][1], f = m[1][2];
    const g = m[2][0], h = m[2][1], i = m[2][2];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
    const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) throw new Error('Singular matrix');
    return [
      [A / det, D / det, G / det],
      [B / det, E / det, H / det],
      [C / det, F / det, I / det]
    ];
  }

  #mat3ToGL(m) {
    return new Float32Array([
      m[0][0], m[1][0], m[2][0],
      m[0][1], m[1][1], m[2][1],
      m[0][2], m[1][2], m[2][2]
    ]);
  }

  // ---------------------------------------------------------------------------
  // GLSL Shaders
  // ---------------------------------------------------------------------------

  #vertexShaderSource() {
    return `
      attribute vec2 a_pos;
      varying vec2 v_pos;
      void main() {
        v_pos = a_pos;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;
  }

  #fragmentShaderSource() {
    return `
      precision mediump float;
      uniform sampler2D u_tex;
      uniform mat3 u_invH;
      uniform vec2 u_resolution;
      uniform vec2 u_srcSize;
      varying vec2 v_pos;

      void main() {
        vec2 coord = gl_FragCoord.xy;
        coord.y = u_resolution.y - coord.y;  // Flip Y to match canvas
        vec3 dst = vec3(coord, 1.0);
        vec3 src = u_invH * dst;
        src /= src.z;
        vec2 uv = src.xy / u_srcSize;

        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)
          discard;

        gl_FragColor = texture2D(u_tex, uv);
      }
    `;
  }
}

// ---------------------------------------------------------------------------
// Export globally (optional)
// ---------------------------------------------------------------------------
window.Perspective = Perspective;
