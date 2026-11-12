'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './digimium-ad.module.css';

const services = ['chatgpt', 'gemini', 'photoshop', 'lightroom', 'evoto', 'runninghub', 'spotify', 'netflix'] as const;
const vectorServices = new Set<string>(['chatgpt', 'gemini', 'spotify', 'netflix']);

export default function DigimiumAd() {
  const scene = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let inView = false;
    const update = () => setVisible(inView && document.visibilityState === 'visible');
    const observer = new IntersectionObserver(entries => {
      inView = entries.some(entry => entry.isIntersecting);
      update();
    }, { threshold: 0.05 });
    if (scene.current) observer.observe(scene.current);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  return <aside className={styles.ad} aria-label="Digimium advertisement">
    <a className={styles.link} href="https://buywith-digimium.store/" target="_blank" rel="sponsored noopener noreferrer">
      <div ref={scene} className={styles.scene} data-moving={visible && !paused} role="img" aria-label="Digimium with floating ChatGPT, Gemini, Photoshop, Lightroom, Evoto, RunningHub, Spotify and Netflix logos">
        <img className={styles.wordmark} src="/digimium/wordmark.png" width="1000" height="340" alt="" />
        {services.map(service => <span key={service} className={`${styles.tile} ${styles[service]}`} aria-hidden="true">
          <img src={`/digimium/services/${service}.${vectorServices.has(service) ? 'svg' : 'png'}`} width="128" height="128" alt="" />
        </span>)}
      </div>
      <div className={styles.content}>
        <h2>Digital subscriptions</h2>
        <p lang="my">AI Tools, Creative App နဲ့ Entertainment App တွေ အားလုံးကို တစ်နေရာတည်းမှာ စုံစုံလင်လင်ဝယ်လို့ရပါပြီ</p>
        <div className={styles.footer}>
          <span className={styles.action}>Visit Digimium <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M5 15 15 5M5 5h10v10" /></svg></span>
          <span className={styles.label}>Ad</span>
        </div>
        <span className={styles.srOnly}>Opens in a new tab.</span>
      </div>
    </a>
    <button className={styles.motionControl} type="button" onClick={() => setPaused(value => !value)} aria-label={paused ? 'Play banner animation' : 'Pause banner animation'} title={paused ? 'Play animation' : 'Pause animation'}>
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="currentColor">{paused ? <path d="m7 4 9 6-9 6V4Z" /> : <path d="M6 4h3v12H6zM12 4h3v12h-3z" />}</svg>
    </button>
  </aside>;
}
