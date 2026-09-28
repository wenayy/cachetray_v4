try {
  if (localStorage.getItem('ct_theme') === 'light') {
    document.documentElement.classList.add('light');
  }
} catch (_) {}
