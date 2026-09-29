import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import DATA from './data/climb.json'

// Real Gwanak-san: terrain from a DEM (AWS Terrain Tiles), campus buildings
// and the trail from OpenStreetMap. Units are metres; heights are exaggerated
// a little so the ridge reads on screen.
export const EXAGGERATE = 1.35
const [WIDTH, DEPTH] = DATA.size
const SEG = 255

// Scroll phases: establishing shot, the climb itself, then the summit reveal.
const INTRO_END = 0.06
const CLIMB_END = 0.88

const terrainVertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main(){
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`

const terrainFragment = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uFog;
  uniform float uFogDensity;
  uniform float uEx;
  uniform float uDawn;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main(){
    float elev = vWorld.y / uEx;
    vec3 n = normalize(vNormal);
    // Forest low down, bare granite toward the top.
    vec3 low = vec3(0.03, 0.07, 0.10);
    vec3 high = vec3(0.16, 0.16, 0.20);
    vec3 base = mix(low, high, smoothstep(250.0, 600.0, elev));
    float diff = max(dot(n, uSunDir), 0.0);
    vec3 col = base * (0.35 + 0.65 * uDawn) + base * uSunColor * diff * 1.6;
    // Contour lines every 20 m, stronger every 100 m.
    float fw = fwidth(elev);
    float c20 = 1.0 - smoothstep(0.0, fw * 1.2, min(fract(elev / 20.0), 1.0 - fract(elev / 20.0)) * 20.0);
    float c100 = 1.0 - smoothstep(0.0, fw * 1.6, min(fract(elev / 100.0), 1.0 - fract(elev / 100.0)) * 100.0);
    col += vec3(0.35, 0.55, 0.9) * c20 * 0.35;
    col += vec3(1.0, 0.78, 0.45) * c100 * 0.55;
    float d = length(vWorld - cameraPosition);
    float fog = 1.0 - exp(-pow(d * uFogDensity, 2.0));
    gl_FragColor = vec4(mix(col, uFog, fog), 1.0);
  }
`

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main(){
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`

const skyFragment = /* glsl */ `
  uniform vec3 uSunDir;
  uniform float uDawn;
  varying vec3 vDir;
  void main(){
    float h = vDir.y;
    vec3 night = mix(vec3(0.05, 0.06, 0.16), vec3(0.01, 0.01, 0.05), smoothstep(0.0, 0.6, h));
    vec3 dawn = mix(vec3(1.0, 0.55, 0.35), vec3(0.25, 0.35, 0.7), smoothstep(-0.02, 0.45, h));
    vec3 col = mix(night, dawn, uDawn * 0.9);
    float s = max(dot(vDir, uSunDir), 0.0);
    col += vec3(1.0, 0.7, 0.4) * pow(s, 8.0) * uDawn * 0.8;
    col += vec3(1.0, 0.9, 0.7) * pow(s, 400.0) * uDawn * 3.0;
    // A few stars fading as the sun comes up.
    vec3 q = floor(vDir * 400.0);
    float star = step(0.9985, fract(sin(dot(q, vec3(12.9898, 78.233, 37.719))) * 43758.5453));
    col += star * smoothstep(0.05, 0.4, h) * (1.0 - uDawn) * 0.9;
    gl_FragColor = vec4(col, 1.0);
  }
`

const buildingVertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main(){
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`

const buildingFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uWindow;
  uniform vec3 uSunDir;
  uniform vec3 uFog;
  uniform float uFogDensity;
  uniform float uDawn;
  varying vec3 vWorld;
  varying vec3 vNormal;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main(){
    vec3 n = normalize(vNormal);
    vec3 col = uColor * (0.4 + 0.6 * max(dot(n, uSunDir), 0.0) * (0.3 + uDawn));
    if (abs(n.y) < 0.5) {
      float along = abs(n.x) > abs(n.z) ? vWorld.z : vWorld.x;
      float fy = fract(vWorld.y / 4.8);
      float band = smoothstep(0.3, 0.4, fy) * (1.0 - smoothstep(0.7, 0.8, fy));
      float cell = floor(along / 3.0);
      float lit = step(0.35, hash(vec2(cell, floor(vWorld.y / 4.8))));
      col += uWindow * band * step(0.35, fract(along / 3.0)) * lit * (1.0 - uDawn * 0.6);
    }
    float d = length(vWorld - cameraPosition);
    float fog = 1.0 - exp(-pow(d * uFogDensity, 2.0));
    gl_FragColor = vec4(mix(col, uFog, fog), 1.0);
  }
`

const trailVertex = /* glsl */ `
  varying float vU;
  void main(){ vU = uv.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`

const trailFragment = /* glsl */ `
  uniform float uProgress;
  uniform float uTime;
  varying float vU;
  void main(){
    float walked = step(vU, uProgress);
    float dash = step(0.5, fract(vU * 240.0 - uTime * 0.6));
    vec3 ahead = mix(vec3(0.25, 0.32, 0.5), vec3(0.75, 0.85, 1.0), dash) * 0.6;
    vec3 done = vec3(1.0, 0.72, 0.3) * 1.4;
    gl_FragColor = vec4(mix(ahead, done, walked), 1.0);
  }
`

export class Climb {
  constructor(canvas) {
    this.canvas = canvas
    this.mobile = innerWidth < 760
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.mobile ? 1.25 : 1.75))
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(50, 1, 5, 20000)
    this.progress = 0
    this.time = 0
    this.mouse = new THREE.Vector2()
    this.sunDir = new THREE.Vector3()
    this.fog = new THREE.Color()
    this.shared = {
      uSunDir: { value: this.sunDir },
      uFog: { value: this.fog },
      uFogDensity: { value: 0.00028 },
      uDawn: { value: 0 },
      uEx: { value: EXAGGERATE },
    }
    window.addEventListener('pointermove', (e) => this.mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1))
  }

  async load() {
    await this.#loadHeight()
    this.#buildSky()
    this.#buildTerrain()
    this.#buildBuildings()
    this.#buildTrail()
    this.#buildPost()
    this.resize()
    // Ignore height-only resizes (mobile address bar); the canvas is 100lvh.
    let w = innerWidth
    window.addEventListener('resize', () => innerWidth !== w && ((w = innerWidth), this.resize()))
  }

  async #loadHeight() {
    const img = new Image()
    img.src = '/height.png'
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(0, 0, c.width, c.height).data
    this.hw = c.width
    this.hh = c.height
    this.heights = new Float32Array(c.width * c.height)
    for (let i = 0; i < this.heights.length; i++) this.heights[i] = (px[i * 4] * 256 + px[i * 4 + 1]) * DATA.heightScale
  }

  // Real ground elevation (metres, not exaggerated) at scene x/z.
  groundAt(x, z) {
    const fx = Math.min(this.hw - 1.001, Math.max(0, (x / WIDTH + 0.5) * (this.hw - 1)))
    const fz = Math.min(this.hh - 1.001, Math.max(0, (z / DEPTH + 0.5) * (this.hh - 1)))
    const i = Math.floor(fx)
    const j = Math.floor(fz)
    const tx = fx - i
    const tz = fz - j
    const h = (a, b) => this.heights[b * this.hw + a]
    const top = h(i, j) * (1 - tx) + h(i + 1, j) * tx
    const bot = h(i, j + 1) * (1 - tx) + h(i + 1, j + 1) * tx
    return top * (1 - tz) + bot * tz
  }

  #buildSky() {
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: { uSunDir: this.shared.uSunDir, uDawn: this.shared.uDawn },
      side: THREE.BackSide,
      depthWrite: false,
    })
    const sky = new THREE.Mesh(new THREE.SphereGeometry(15000, 32, 16), this.skyMat)
    sky.renderOrder = -1
    this.sky = sky
    this.scene.add(sky)
  }

  #buildTerrain() {
    const geo = new THREE.PlaneGeometry(WIDTH, DEPTH, SEG, SEG)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position
    for (let k = 0; k < pos.count; k++) pos.setY(k, this.groundAt(pos.getX(k), pos.getZ(k)) * EXAGGERATE)
    geo.computeVertexNormals()
    this.terrainMat = new THREE.ShaderMaterial({
      vertexShader: terrainVertex,
      fragmentShader: terrainFragment,
      uniforms: { ...this.shared, uSunColor: { value: new THREE.Color('#ffb070') } },
    })
    this.scene.add(new THREE.Mesh(geo, this.terrainMat))
  }

  #buildBuildings() {
    const groups = { campus: [], town: [] }
    for (const b of DATA.buildings) {
      const shape = new THREE.Shape(b.p.map(([x, z]) => new THREE.Vector2(x, -z)))
      // Sink the base a little so buildings on slopes don't float.
      const geo = new THREE.ExtrudeGeometry(shape, { depth: b.h * EXAGGERATE + 6, bevelEnabled: false })
      geo.rotateX(-Math.PI / 2)
      geo.translate(0, b.y * EXAGGERATE - 6, 0)
      groups[b.c ? 'campus' : 'town'].push(geo)
    }
    const mat = (color, windows) =>
      new THREE.ShaderMaterial({
        vertexShader: buildingVertex,
        fragmentShader: buildingFragment,
        uniforms: { ...this.shared, uColor: { value: new THREE.Color(color) }, uWindow: { value: new THREE.Color(windows) } },
      })
    this.scene.add(new THREE.Mesh(mergeGeometries(groups.campus), mat('#8a9cc8', '#ffd48a')))
    this.scene.add(new THREE.Mesh(mergeGeometries(groups.town), mat('#2a3350', '#b08a55')))
  }

  #buildTrail() {
    const pts = DATA.trail.map(([x, y, z]) => new THREE.Vector3(x, y * EXAGGERATE + 3, z))
    this.trail = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.2)
    this.trailLength = this.trail.getLength()
    this.trailMat = new THREE.ShaderMaterial({
      vertexShader: trailVertex,
      fragmentShader: trailFragment,
      uniforms: { uProgress: { value: 0 }, uTime: { value: 0 } },
    })
    this.scene.add(new THREE.Mesh(new THREE.TubeGeometry(this.trail, 1600, 2.2, 6, false), this.trailMat))

    // The climber: a bright point of light with a halo.
    const halo = document.createElement('canvas')
    halo.width = halo.height = 64
    const hctx = halo.getContext('2d')
    const g = hctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,240,210,1)')
    g.addColorStop(0.25, 'rgba(255,190,110,0.7)')
    g.addColorStop(1, 'rgba(255,160,80,0)')
    hctx.fillStyle = g
    hctx.fillRect(0, 0, 64, 64)
    this.climber = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(halo), depthWrite: false, blending: THREE.AdditiveBlending }))
    this.climber.scale.setScalar(16)
    this.scene.add(this.climber)
  }

  #buildPost() {
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.5, 0.75))
    this.composer.addPass(new OutputPass())
  }

  resize() {
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    this.renderer.setSize(w, h, false)
    this.composer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.fov = w / h < 0.8 ? 65 : 50
    this.camera.updateProjectionMatrix()
  }

  // 0..1 along the trail for the current scroll position.
  trailT() {
    return Math.min(1, Math.max(0, (this.progress - INTRO_END) / (CLIMB_END - INTRO_END)))
  }

  // Summit reveal amount (0..1).
  reveal() {
    const r = Math.min(1, Math.max(0, (this.progress - CLIMB_END) / (1 - CLIMB_END)))
    return r * r * (3 - 2 * r)
  }

  // Climber's real elevation (m) and distance walked (m).
  stats() {
    const p = this.trail.getPointAt(this.smoothT ?? 0)
    return { elevation: this.groundAt(p.x, p.z), walked: (this.smoothT ?? 0) * this.trailLength, total: this.trailLength }
  }

  // Screen position of a world point, or null when behind the camera.
  screen(v) {
    const p = v.clone().project(this.camera)
    if (p.z > 1) return null
    return { x: (p.x * 0.5 + 0.5) * this.canvas.clientWidth, y: (-p.y * 0.5 + 0.5) * this.canvas.clientHeight }
  }

  render(dt) {
    this.time += dt
    const t = this.trailT()
    this.smoothT = this.smoothT === undefined ? t : this.smoothT + (t - this.smoothT) * Math.min(1, dt * 4)
    const st = this.smoothT
    const dawn = Math.min(1, Math.max(0, (this.progress - 0.2) / 0.75))

    // Sun rises in the east (+x) as we climb.
    const sunElev = -0.08 + dawn * 0.35
    this.sunDir.set(0.9, sunElev, -0.35).normalize()
    this.shared.uDawn.value = dawn
    // Dawn haze: warm but kept dark enough that the summit view stays readable.
    this.fog.setRGB(0.05 + dawn * 0.22, 0.06 + dawn * 0.12, 0.14 + dawn * 0.08)
    this.shared.uFogDensity.value = 0.00028 - this.reveal() * 0.00014

    const here = this.trail.getPointAt(st)
    const behind = this.trail.getPointAt(Math.max(0, st - 0.035))
    const ahead = this.trail.getPointAt(Math.min(1, st + 0.02))
    this.climber.position.copy(here).add(new THREE.Vector3(0, 6, 0))

    // Follow cam: above and behind the climber, looking a little ahead.
    const back = here.clone().sub(behind).setY(0).normalize()
    const followEye = here.clone().sub(back.clone().multiplyScalar(170)).add(new THREE.Vector3(0, 120, 0))
    followEye.y = Math.max(followEye.y, this.groundAt(followEye.x, followEye.z) * EXAGGERATE + 60)
    const followLook = ahead.clone().add(new THREE.Vector3(0, 10, 0))

    // Intro: high over the gate, the whole mountain ahead.
    const start = this.trail.getPointAt(0)
    const peak = this.trail.getPointAt(1)
    const introEye = start.clone().add(new THREE.Vector3(-250, 700, 900))
    const introLook = start.clone().lerp(peak, 0.55)
    const ki = 1 - Math.min(1, this.progress / INTRO_END)
    const kIntro = ki * ki * (3 - 2 * ki)

    // Summit: rise above the peak and turn to look north over the campus.
    const campus = start.clone().lerp(peak, 0.28)
    const revealEye = peak.clone().add(new THREE.Vector3(160, 220, 380))
    const kr = this.reveal()

    const eye = followEye.lerp(introEye, kIntro).lerp(revealEye, kr)
    const look = followLook.lerp(introLook, kIntro).lerp(campus, kr)
    if (!this.camEye) (this.camEye = eye.clone()), (this.camLook = look.clone())
    this.camEye.lerp(eye, Math.min(1, dt * 3))
    this.camLook.lerp(look, Math.min(1, dt * 3))
    this.camera.position.copy(this.camEye).add(new THREE.Vector3(this.mouse.x * 20, this.mouse.y * 12, 0))
    this.camera.lookAt(this.camLook)
    this.sky.position.copy(this.camera.position)

    this.trailMat.uniforms.uProgress.value = st
    this.trailMat.uniforms.uTime.value = this.time
    this.composer.render()
  }
}
