// Apply the theme before first paint to avoid a flash. Loaded as a file, not
// inline, so the page works under script-src 'self'.
try {
  var t = localStorage.getItem('eve_theme');
  if (t === 'dark' || (t !== 'light' && !window.matchMedia('(prefers-color-scheme: light)').matches)) {
    document.documentElement.classList.add('dark');
  }
} catch (e) {}
