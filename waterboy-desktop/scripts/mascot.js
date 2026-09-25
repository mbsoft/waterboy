// The Waterboy mascot: a sports squeeze bottle with a face (water inside, droplet at the spout).
// Shared by the app icon (make-icon.js) and the Buy Me a Coffee banner (make-banner.js).
// Returns an <svg> on a 0-100 viewBox; ids are prefixed so several can share a page.
module.exports = (size, id = "m", style = "") => `<svg width="${size}" height="${size}" viewBox="0 0 100 100" style="${style}">
    <defs>
      <clipPath id="${id}-body"><rect x="30" y="37" width="40" height="50" rx="10"/></clipPath>
      <linearGradient id="${id}-water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7fe0ff"/><stop offset="1" stop-color="#2bb4f0"/></linearGradient>
      <filter id="${id}-s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1.2" stdDeviation="1.2" flood-color="#06205c" flood-opacity=".35"/></filter>
    </defs>
    <g filter="url(#${id}-s)">
      <!-- spout straw -->
      <path d="M50 22 L50 14 Q50 11 53 10.5 L58 9.5" fill="none" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
      <!-- cap -->
      <rect x="39" y="22" width="22" height="9" rx="3" fill="#ffffff"/>
      <rect x="36.5" y="30" width="27" height="8" rx="3" fill="#e8f1ff"/>
      <!-- bottle -->
      <rect x="30" y="37" width="40" height="50" rx="10" fill="#ffffff"/>
      <g clip-path="url(#${id}-body)">
        <path d="M30 67 Q37.5 63.5 45 67 T60 67 T75 67 V90 H30 Z" fill="url(#${id}-water)"/>
        <!-- sport stripes -->
        <rect x="28" y="42.5" width="44" height="3.2" fill="#1a5ce0"/>
        <rect x="28" y="47.3" width="44" height="1.5" fill="#1a5ce0" opacity=".7"/>
      </g>
      <!-- face -->
      <circle cx="43.5" cy="56" r="2.3" fill="#0c2f86"/>
      <circle cx="56.5" cy="56" r="2.3" fill="#0c2f86"/>
      <circle cx="44.3" cy="55.2" r=".7" fill="#ffffff"/>
      <circle cx="57.3" cy="55.2" r=".7" fill="#ffffff"/>
      <path d="M46.5 60.2 Q50 63.2 53.5 60.2" fill="none" stroke="#0c2f86" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="39.5" cy="60" r="2" fill="#ff8fb1" opacity=".55"/>
      <circle cx="60.5" cy="60" r="2" fill="#ff8fb1" opacity=".55"/>
      <!-- highlight -->
      <rect x="34.5" y="70" width="3" height="12" rx="1.5" fill="#ffffff" opacity=".55"/>
    </g>
    <!-- droplet -->
    <path d="M64 8 C64 8 60 13.5 60 16 A4 4 0 0 0 68 16 C68 13.5 64 8 64 8 Z" fill="#8fe6ff" stroke="#ffffff" stroke-width="1.2"/>
</svg>`;
