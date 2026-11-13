'use client';

import { useEffect, useId, useRef, useState } from 'react';
import styles from './digimium-slideshow.module.css';

const storeURL = 'https://buywith-digimium.store/';
const products = [
  ['chatgpt', 'ChatGPT'], ['gemini', 'Gemini'], ['photoshop', 'Photoshop'],
  ['netflix', 'Netflix'], ['lightroom', 'Lightroom'], ['spotify', 'Spotify'],
] as const;
const slideNames = ['Apps in one place', 'Easy ordering', 'Payment and usage guidance', 'Plans and prices'];

function Arrow({ back = false }: { back?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d={back ? 'M19 12H5m7 7-7-7 7-7' : 'M5 12h14m-7-7 7 7-7 7'} /></svg>;
}
function Check() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>;
}
function Telegram() {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.5 3.4 18 20.1c-.3 1.2-1 1.5-2 .9l-5.3-3.9-2.6 2.5c-.3.3-.6.5-1.1.5l.4-5.4L17.2 6c.4-.4-.1-.6-.6-.3L4.5 13.3.1 11.9c-1-.3-1-1 .2-1.5L19.8 2.8c.9-.3 1.7.2 1.7.6Z" /></svg>;
}
function ProductLogo({ name, label }: { name: string; label: string }) {
  return <img src={`/digimium/services/${name}.svg`} width="96" height="96" alt={label} />;
}

export default function DigimiumSlideshow({ onDismiss }: { onDismiss: (restoreFocus: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [slide, setSlide] = useState(0);
  const [closeAvailable, setCloseAvailable] = useState(false);
  const [paused, setPaused] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const [visible, setVisible] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => setReducedMotion(media.matches);
    const updateVisibility = () => setVisible(document.visibilityState === 'visible');
    updateMotion();
    updateVisibility();
    media.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      media.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (!node.open) node.showModal();
    return () => node.close();
  }, []);
  useEffect(() => {
    if (paused || interacting || !visible || reducedMotion || slide === slideNames.length - 1) return;
    const timer = window.setTimeout(() => {
      setSlide(current => Math.min(current + 1, slideNames.length - 1));
      setCloseAvailable(true);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [paused, interacting, visible, reducedMotion, slide]);

  function goTo(index: number) {
    setSlide(index);
    setPaused(true);
    if (index >= 1) setCloseAvailable(true);
  }
  function dismiss() { dialog.current?.close(); }
  function visitStore() { setCloseAvailable(true); setPaused(true); }

  return <dialog ref={dialog} className={styles.modal} aria-labelledby={title} aria-modal="true"
    onClose={event => {
      if (dialog.current?.open) return;
      const focused = document.activeElement;
      onDismiss(!focused || focused === document.body || event.currentTarget.contains(focused));
    }}
    onPointerDown={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismiss();
    }}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowRight' && slide < 3) { event.preventDefault(); goTo(slide + 1); }
      if (event.key === 'ArrowLeft' && slide > 0) { event.preventDefault(); goTo(slide - 1); }
    }}>
    <div className={styles.top}>
      <div className={styles.identity}><span className={styles.adLabel} lang="my">ကြော်ငြာ · Ad</span><h2 id={title}>Digimium</h2></div>
      <div className={styles.closeSlot}>{closeAvailable && <button className={styles.close} type="button" onClick={dismiss} aria-label="Close advertisement"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button>}</div>
    </div>
    <div className={styles.stage} onMouseEnter={() => setInteracting(true)} onMouseLeave={() => setInteracting(false)}
      onFocusCapture={() => setInteracting(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setInteracting(false); }}>
      <img className={styles.wordmark} src="/digimium/wordmark.png" width="160" height="55" alt="digimium" />
      <section className={styles.slide} aria-roledescription="slide" aria-label={`${slide + 1} of 4: ${slideNames[slide]}`}>
        <div className={styles.copy} lang="my">
          {slide === 0 && <><h3>လိုအပ်တဲ့ App တွေ<span>တစ်နေရာတည်းမှာ ဝယ်ပါ။</span></h3><p>AI · Creative · Entertainment</p></>}
          {slide === 1 && <><h3>စိတ်ကြိုက်ရွေးချယ်ပြီး<span>Order တင်ရုံပါပဲ</span></h3><p>App ရွေး → Plan ရွေး → Telegram မှာ Send</p></>}
          {slide === 2 && <><h3>ငွေပေးချေဖို့<span>Plan အသေးစိတ်</span></h3><p>အသုံးပြုပုံအဆင့်ဆင့်ကို အသေးစိတ်ကူညီပေးမည်</p></>}
          {slide === 3 && <><h3>သင့်တင့်တဲ့ဈေးနှုန်းနဲ့<span>စိတ်ကြိုက်ရွေးဝယ်ပါ။</span></h3><p>ကိုယ်နဲ့ကိုက်တဲ့ Plan နဲ့ လက်ရှိဈေးနှုန်းကို အရင်မေးမြန်းနိုင်ပါတယ်။</p><a className={styles.storeCTA} href={storeURL} target="_blank" rel="sponsored noopener noreferrer" onClick={visitStore}>Digimium မှာ ရွေးကြည့်မယ် <Arrow /><span className={styles.srOnly}> (opens in a new tab)</span></a></>}
        </div>
        {slide === 0 && <div className={styles.products}>{products.map(([name, label]) => <div key={name}><ProductLogo name={name} label="" /><span>{label}</span></div>)}</div>}
        {slide === 1 && <div className={styles.order} lang="my">
          <div className={styles.path}><span>App</span><Arrow /><span>Plan</span><Arrow /><span>Telegram</span></div>
          <div className={styles.sheet}><p className={styles.sheetLabel}>သင်ရွေးထားတဲ့ Plan</p><div className={styles.productLine}><ProductLogo name="gemini" label="" /><div><strong>Gemini</strong><p>Plan ရွေးပြီးပါပြီ</p></div><Check /></div><div className={styles.sendBar}><Telegram /><span>Telegram မှာ Order ပို့မယ်</span><Arrow /></div></div>
        </div>}
        {slide === 2 && <div className={styles.chat} lang="my">
          <div className={styles.chatTitle}><Telegram /><strong>digimium</strong><span>Telegram</span></div><p className={styles.bubble}>ရွေးထားတဲ့ Plan ကို ဝယ်ချင်လို့ပါ။</p><div className={styles.reply}><p>ရပါတယ်ခင်ဗျ။</p>{['ငွေပေးချေနည်း', 'Plan အသေးစိတ်', 'အသုံးပြုပုံအဆင့်ဆင့်'].map(text => <div key={text}><Check /><span>{text}</span></div>)}</div>
        </div>}
        {slide === 3 && <div className={styles.choices} lang="my"><p>သင်လိုအပ်တာကို ရွေးပါ။</p><div className={styles.choiceLogos}>{products.filter(([name]) => ['chatgpt', 'gemini', 'spotify'].includes(name)).map(([name, label]) => <ProductLogo key={name} name={name} label={label} />)}</div>{['App အမျိုးအစားစုံ', 'Plan နဲ့ ဈေးနှုန်း မေးမြန်းနိုင်', 'ဝယ်ယူဖို့ Chat မှာ ကူညီပေးမယ်'].map(text => <div className={styles.choiceLine} key={text}><span>{text}</span><Check /></div>)}</div>}
      </section>
    </div>
    <div className={styles.bottom}>
      <a className={styles.storeLink} href={storeURL} target="_blank" rel="sponsored noopener noreferrer" onClick={visitStore}>Visit Digimium ↗<span className={styles.srOnly}> (opens in a new tab)</span></a>
      <div className={styles.navigation} role="group" aria-label="Advertisement slides">
        {!reducedMotion && <button className={styles.iconButton} type="button" onClick={() => setPaused(value => !value)} aria-label={paused ? 'Play slideshow' : 'Pause slideshow'} aria-pressed={paused}><svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">{paused ? <path d="m7 4 9 6-9 6V4Z" /> : <path d="M6 4h3v12H6zM12 4h3v12h-3z" />}</svg></button>}
        <button className={styles.iconButton} type="button" disabled={slide === 0} aria-label="Previous slide" onClick={() => goTo(slide - 1)}><Arrow back /></button>
        <span className={styles.counter} aria-live="polite" aria-atomic="true">{slide + 1} / 4<span className={styles.srOnly}>: {slideNames[slide]}</span></span>
        <button className={styles.iconButton} type="button" disabled={slide === 3} aria-label="Next slide" onClick={() => goTo(slide + 1)}><Arrow /></button>
      </div>
      <button className={styles.skip} type="button" onClick={dismiss} autoFocus>Skip ad <span aria-hidden="true">→</span></button>
    </div>
  </dialog>;
}
