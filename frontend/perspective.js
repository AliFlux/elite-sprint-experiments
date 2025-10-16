// ---------------------------------------------------------------------------
// Perspective.js (with optional Sobel filter and configurable background)
// ---------------------------------------------------------------------------

class Perspective {
  constructor(ctx2d, source, { filter = "sobel", background = [0, 0, 0, 0] } = {}) {
    if (!ctx2d || !source) throw new Error('Perspective: invalid arguments');

    const imgW = source.videoWidth || source.width;
    const imgH = source.videoHeight || source.height;

    this.ctx2d = ctx2d;
    this.source = source;
    this.dstW = ctx2d.canvas.width;
    this.dstH = ctx2d.canvas.height;
    this.srcW = imgW;
    this.srcH = imgH;
    this.filter = filter;
    this.background = background;

    // Initialize WebGL
    const { gl, canvas } = this.#createGLContext(this.dstW, this.dstH);
    this.gl = gl;
    this.glCanvas = canvas;

    // Compile shaders and program
    this.program = this.#createProgram(
      gl,
      this.#vertexShaderSource(),
      this.filter === 'sobel'
        ? this.#fragmentShaderSourceSobel()
        : this.#fragmentShaderSourceNormal()
    );

    // Quad
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    // Shader locations
    this.a_pos = gl.getAttribLocation(this.program, 'a_pos');
    this.u_tex = gl.getUniformLocation(this.program, 'u_tex');
    this.u_invH = gl.getUniformLocation(this.program, 'u_invH');
    this.u_resolution = gl.getUniformLocation(this.program, 'u_resolution');
    this.u_srcSize = gl.getUniformLocation(this.program, 'u_srcSize');

    // Edge uniforms (if Sobel)
    if (this.filter === 'sobel') {
      this.u_edgeColor = gl.getUniformLocation(this.program, 'u_edgeColor');
      this.u_threshold = gl.getUniformLocation(this.program, 'u_threshold');
      this.u_thickness = gl.getUniformLocation(this.program, 'u_thickness');
    }

    // Create texture
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    gl.viewport(0, 0, this.dstW, this.dstH);

    // Background color (semi-transparent)
    gl.clearColor(background[0], background[1], background[2], background[3]);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);


    // Default edge params
    this.edgeColor = [1.0, 1.0, 1.0, 1.0];
    this.threshold = 0.1;
    this.thickness = 0.2;
  }

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

    // Update texture
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);

    // Compute homography
    const H = this.#computeHomography(src, dst);
    const invH = this.#invert3x3(H);

    // Render
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

    if (this.filter === 'sobel') {
      gl.uniform4f(
        this.u_edgeColor,
        this.edgeColor[0],
        this.edgeColor[1],
        this.edgeColor[2],
        this.edgeColor[3]
      );
      gl.uniform1f(this.u_threshold, this.threshold);
      gl.uniform1f(this.u_thickness, this.thickness);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Composite
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
  setEdgeColor(r, g, b, a = 1.0) {
    this.edgeColor = [r, g, b, a];
  }
  setEdgeThreshold(t) {
    this.threshold = Math.max(0, Math.min(1, t));
  }
  setEdgeThickness(t) {
    this.thickness = Math.max(0, Math.min(1, t));
  }

  // ---------------------------------------------------------------------------
  // Internal helpers (unchanged math)
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
      let maxRow = i;
      for (let r = i + 1; r < n; r++)
        if (Math.abs(M[r][i]) > Math.abs(M[maxRow][i])) maxRow = r;
      [M[i], M[maxRow]] = [M[maxRow], M[i]];
      if (Math.abs(M[i][i]) < eps) throw new Error('Singular matrix');
      const diag = M[i][i];
      for (let j = i; j <= n; j++) M[i][j] /= diag;
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
  // GLSL
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

  // Normal image shader
  #fragmentShaderSourceNormal() {
    return `
      precision mediump float;
      uniform sampler2D u_tex;
      uniform mat3 u_invH;
      uniform vec2 u_resolution;
      uniform vec2 u_srcSize;
      varying vec2 v_pos;
      void main() {
        vec2 coord = gl_FragCoord.xy;
        coord.y = u_resolution.y - coord.y;
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

  // Sobel edge shader
  #fragmentShaderSourceSobel() {
    return `
      precision highp float;
      uniform sampler2D u_tex;
      uniform mat3 u_invH;
      uniform vec2 u_resolution;
      uniform vec2 u_srcSize;
      uniform vec4 u_edgeColor;
      uniform float u_threshold;
      uniform float u_thickness;
      varying vec2 v_pos;

      float lum(vec3 c){return dot(c, vec3(0.299,0.587,0.114));}

      void main(){
        vec2 coord = gl_FragCoord.xy;
        coord.y = u_resolution.y - coord.y;
        vec3 dst = vec3(coord,1.0);
        vec3 src = u_invH*dst; src/=src.z;
        vec2 uv=src.xy/u_srcSize;
        if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0) discard;
        vec2 ts=1.0/u_srcSize;
        float c00=lum(texture2D(u_tex,uv+vec2(-ts.x,-ts.y)).rgb);
        float c10=lum(texture2D(u_tex,uv+vec2(0.0,-ts.y)).rgb);
        float c20=lum(texture2D(u_tex,uv+vec2(ts.x,-ts.y)).rgb);
        float c01=lum(texture2D(u_tex,uv+vec2(-ts.x,0.0)).rgb);
        float c21=lum(texture2D(u_tex,uv+vec2(ts.x,0.0)).rgb);
        float c02=lum(texture2D(u_tex,uv+vec2(-ts.x,ts.y)).rgb);
        float c12=lum(texture2D(u_tex,uv+vec2(0.0,ts.y)).rgb);
        float c22=lum(texture2D(u_tex,uv+vec2(ts.x,ts.y)).rgb);
        float gx=-c00-2.0*c01-c02+c20+2.0*c21+c22;
        float gy=-c00-2.0*c10-c20+c02+2.0*c12+c22;
        float g=length(vec2(gx,gy))/8.0;
        float t=clamp(u_thickness,0.0001,0.5);
        float edge=smoothstep(u_threshold-t,u_threshold+t,g);
        float a=edge*u_edgeColor.a;
        if(a<=0.001) discard;
        gl_FragColor=vec4(u_edgeColor.rgb,a);
      }
    `;
  }
}

// ---------------------------------------------------------------------------
// Export globally
// ---------------------------------------------------------------------------
window.Perspective = Perspective;
