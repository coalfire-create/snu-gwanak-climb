import './style.css'
import gsap from 'gsap'
import Lenis from 'lenis'
import * as THREE from 'three'
import { Climb, EXAGGERATE } from './scene.js'
import DATA from './data/climb.json'

const OFFICIAL_SUMMIT = 632 // 관악산 정상, official height (the 10 m DEM smooths the rock to ~618 m)
const clamp01 = (v) => Math.min(1, Math.max(0, v))

async function boot() {
  const loaderAlt = document.getElementById('loaderAlt')
  const count = { v: 0 }
  const tween = gsap.to(count, { v: 632, duration: 1.6, ease: 'power2.inOut', onUpdate: () => (loaderAlt.textContent = Math.round(count.v)) })

  const climb = new Climb(document.getElementById('gl'))
  await Promise.all([
    climb.load(),
    document.fonts.load('400 40px "Black Han Sans"', '관악산'),
    tween,
  ])

  if (import.meta.env.DEV) window.__climb = climb
  const lenis = new Lenis({ lerp: 0.08, wheelMultiplier: 0.8 })
  gsap.ticker.add((t) => lenis.raf(t * 1000))
  gsap.ticker.lagSmoothing(0)
  document.getElementById('climbAgain').addEventListener('click', (e) => {
    e.preventDefault()
    lenis.scrollTo(0, { duration: 3 })
  })

  gsap.to('#loader', { opacity: 0, duration: 0.8, delay: 0.2, onComplete: () => document.getElementById('loader').remove() })

  /* labels: named peaks and campus buildings */
  const tagWrap = document.getElementById('tags')
  const makeTag = (text, cls) => {
    const el = document.createElement('span')
    el.className = `tag ${cls}`
    el.innerHTML = text
    tagWrap.appendChild(el)
    return el
  }
  const peaks = DATA.landmarks
    .filter((l) => l.peak)
    .map((l) => ({
      pos: new THREE.Vector3(l.x, climb.groundAt(l.x, l.z) * EXAGGERATE + 25, l.z),
      el: makeTag(`${l.name}<small>${Math.round(l.y)}m</small>`, 'tag--peak'),
    }))
  const buildings = DATA.buildings
    .filter((b) => b.n)
    .map((b) => {
      const cx = b.p.reduce((a, q) => a + q[0], 0) / b.p.length
      const cz = b.p.reduce((a, q) => a + q[1], 0) / b.p.length
      return { pos: new THREE.Vector3(cx, (b.y + b.h) * EXAGGERATE + 8, cz), el: makeTag(b.n, 'tag--bldg') }
    })

  /* HUD */
  const altEl = document.getElementById('altValue')
  const distEl = document.getElementById('distValue')
  // Map distance, as a hiker would measure it (the 3D curve also counts exaggerated climb).
  const mapLength = DATA.trail.reduce((a, q, i, all) => (i ? a + Math.hypot(q[0] - all[i - 1][0], q[2] - all[i - 1][2]) : 0), 0)
  document.getElementById('distTotal').textContent = (mapLength / 1000).toFixed(1)
  const gauge = document.getElementById('gaugeFill')
  const hud = document.getElementById('hud')
  const stages = [...document.querySelectorAll('.stage')].map((el) => ({ el, from: +el.dataset.from, to: +el.dataset.to }))
  const trackEl = document.getElementById('track')
  const summitTrailElev = DATA.trail[DATA.trail.length - 1][1]

  // Mobile browsers change innerHeight as the address bar slides; only take a
  // new viewport height when the width changes (rotation, real resize).
  let viewH = innerHeight
  let viewW = innerWidth
  addEventListener('resize', () => {
    if (innerWidth !== viewW) (viewW = innerWidth), (viewH = innerHeight)
  })

  let last = performance.now()
  gsap.ticker.add(() => {
    const now = performance.now()
    const dt = Math.min((now - last) / 1000, 0.05)
    last = now

    const max = trackEl.offsetHeight - viewH
    const p = clamp01(scrollY / max)
    climb.progress = p
    climb.render(dt)

    // Altitude: real DEM under the climber, easing to the official summit
    // height over the last stretch where the DEM smooths the peak.
    const s = climb.stats()
    const t = s.walked / s.total
    const fix = clamp01((t - 0.95) / 0.05) * (OFFICIAL_SUMMIT - summitTrailElev)
    const alt = Math.round(s.elevation + fix)
    altEl.textContent = alt
    distEl.textContent = ((t * mapLength) / 1000).toFixed(1)
    gauge.style.transform = `scaleY(${alt / OFFICIAL_SUMMIT})`
    hud.style.opacity = p < 0.04 ? p / 0.04 : 1

    for (const st of stages) {
      const span = st.to - st.from
      const fade = Math.min(clamp01((p - st.from) / (span * 0.2)), clamp01((st.to - p) / (span * 0.2)))
      st.el.style.opacity = fade
      st.el.style.visibility = fade > 0.01 ? 'visible' : 'hidden'
      st.el.style.translate = `0 ${(1 - fade) * 24}px`
    }

    // Peaks always; campus building names only while we're down among them
    // or looking back over them from the top. Overlapping tags are skipped.
    // Labels already on screen keep their spot (placed first), and every
    // label fades in and out instead of popping, so they don't flicker as
    // the camera moves.
    const placed = []
    const shown = new Set()
    const place = (item, visible, opacity) => {
      const sc = visible && climb.screen(item.pos)
      let ok = !!sc && sc.x > 0 && sc.x < innerWidth && sc.y > 70 && sc.y < innerHeight
      if (ok) {
        const w = item.w ?? (item.w = item.el.offsetWidth)
        const h = item.h ?? (item.h = item.el.offsetHeight)
        const box = { l: sc.x - w / 2 - 4, r: sc.x + w / 2 + 4, t: sc.y - h - 2, b: sc.y + 2 }
        ok = !placed.some((q) => box.l < q.r && box.r > q.l && box.t < q.b && box.b > q.t) && !shown.has(item.el.textContent)
        if (ok) placed.push(box), shown.add(item.el.textContent)
      }
      // A label must stay clear for 0.2 s before appearing (no flicker in gaps).
      item.clear = ok ? (item.clear ?? 0) + dt : 0
      item.on = ok && (item.on || item.clear > 0.2)
      const target = item.on ? opacity : 0
      item.a = (item.a ?? 0) + (target - (item.a ?? 0)) * Math.min(1, dt * 8)
      item.el.style.visibility = item.a > 0.02 ? 'visible' : 'hidden'
      item.el.style.opacity = item.a
      if (sc) item.el.style.transform = `translate(${sc.x}px, ${sc.y}px) translate(-50%, -100%)`
    }
    const near = Math.max(clamp01(1 - (p - 0.3) / 0.08), clamp01((p - 0.9) / 0.04) * (p < 0.95 ? 1 : 0))
    const all = [...peaks.map((it) => [it, p > 0.02 && p < 0.95, 1]), ...buildings.map((it) => [it, near > 0.05, near])]
    all.sort((x, y) => (y[0].on ? 1 : 0) - (x[0].on ? 1 : 0))
    for (const [it, vis, op] of all) place(it, vis, op)
  })
}

boot()
