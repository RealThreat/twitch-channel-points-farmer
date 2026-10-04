// Tab opened by the extension: flagged with ?taw=1, remembered so it survives reloads.
const managed =
  new URLSearchParams(location.search).has('taw') || sessionStorage.getItem('taw') === '1';

if (managed) {
  sessionStorage.setItem('taw', '1');

  // Force the lowest quality before the player loads, then restore the original
  // preference so regular Twitch tabs are not downgraded.
  const LOW = '{"default":"160p30"}';
  const prev = localStorage.getItem('video-quality');
  if (prev !== LOW) {
    localStorage.setItem('video-quality', LOW);
    setTimeout(() => {
      if (prev === null) localStorage.removeItem('video-quality');
      else localStorage.setItem('video-quality', prev);
    }, 30000);
  }

  const style = document.createElement('style');
  style.textContent = `
    video { display: none !important; }
    .chat-scrollable-area__message-container { display: none !important; }
  `;
  document.documentElement.append(style);
}

setInterval(() => {
  document.querySelector('.claimable-bonus__icon')?.closest('button')?.click();
  if (managed) {
    document
      .querySelector('[data-a-target="content-classification-gate-overlay-start-watching-button"]')
      ?.click();
  }
}, 5000);
