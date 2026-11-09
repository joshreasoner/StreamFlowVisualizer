/**
 * Theme management system for light/dark mode
 * Persists theme preference to localStorage
 */

const THEME_KEY = 'streamflow-theme';
const DARK_THEME = 'dark';
const LIGHT_THEME = 'light';

export function initTheme() {
  const savedTheme = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initialTheme = savedTheme || (prefersDark ? DARK_THEME : LIGHT_THEME);
  
  setTheme(initialTheme);
  setupThemeToggleListener();
}

export function setTheme(theme) {
  if (theme !== DARK_THEME && theme !== LIGHT_THEME) {
    console.warn(`Invalid theme: ${theme}. Using dark theme.`);
    theme = DARK_THEME;
  }
  
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
  updateThemeToggleButton(theme);
  
  // Update meta theme-color for mobile browsers
  const themeColor = theme === DARK_THEME ? '#101616' : '#f8fbf9';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
}

export function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || DARK_THEME;
  const newTheme = currentTheme === DARK_THEME ? LIGHT_THEME : DARK_THEME;
  setTheme(newTheme);
}

export function getCurrentTheme() {
  return document.documentElement.getAttribute('data-theme') || DARK_THEME;
}

function setupThemeToggleListener() {
  const toggleButton = document.querySelector('[data-theme-toggle]');
  if (toggleButton) {
    toggleButton.addEventListener('click', toggleTheme);
  }
}

function updateThemeToggleButton(theme) {
  const toggleButton = document.querySelector('[data-theme-toggle]');
  if (toggleButton) {
    const icon = theme === DARK_THEME ? '☀️' : '🌙';
    const label = theme === DARK_THEME ? 'Switch to light mode' : 'Switch to dark mode';
    toggleButton.setAttribute('aria-label', label);
    toggleButton.setAttribute('title', label);
    
    // Update button content (icon span)
    const iconSpan = toggleButton.querySelector('.theme-icon');
    if (iconSpan) {
      iconSpan.textContent = icon;
    }
  }
}
