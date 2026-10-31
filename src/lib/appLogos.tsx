import { createElement, type ReactElement } from "react";

/**
 * appLogos.tsx — simplified, hand-drawn flat brand marks for real apps.
 * Used by the Activity time-tracking view (dock + app rows) and anywhere
 * an app id needs a recognizable face.
 *
 * Rules of the house:
 * - self-contained: no imports except react types, no <img>, no base64
 * - deterministic + SSR-safe: pure render, no state/effects/random
 * - flat bold shapes, readable at 14–20px, ≤12 svg elements per logo
 * - viewBox is always "0 0 24 24"
 */

export type AppLogoProps = { size?: number; className?: string };
export type AppLogoComponent = (p: AppLogoProps) => ReactElement;

/* ---------------------------------------------------------------- logos -- */

const Discord: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      d="M6.6 6.2C9 4.9 15 4.9 17.4 6.2C19.5 7.1 20.4 9.5 20.7 11.8C21 14.5 20.8 17.2 19.3 19.2L15.7 16.9C16.1 16.5 16.5 16 16.8 15.4C14.1 16.9 9.9 16.9 7.2 15.4C7.5 16 7.9 16.5 8.3 16.9L4.7 19.2C3.2 17.2 3 14.5 3.3 11.8C3.6 9.5 4.5 7.1 6.6 6.2Z"
      fill="#5865F2"
    />
    <ellipse cx="9.1" cy="12.2" rx="1.7" ry="2" fill="#fff" />
    <ellipse cx="14.9" cy="12.2" rx="1.7" ry="2" fill="#fff" />
  </svg>
);

const Chrome: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d="M12 12 3.34 7A10 10 0 0 1 20.66 7Z" fill="#EA4335" />
    <path d="M12 12 20.66 7A10 10 0 0 1 12 22Z" fill="#34A853" />
    <path d="M12 12 12 22A10 10 0 0 1 3.34 7Z" fill="#FBBC05" />
    <circle cx="12" cy="12" r="5" fill="#fff" />
    <circle cx="12" cy="12" r="3.6" fill="#4285F4" />
  </svg>
);

const VSCode: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      d="M22.4 2.4 17.5.1a1.4 1.4 0 0 0-1.6.3L6.6 8.9 2.6 5.8a.9.9 0 0 0-1.2.1L.2 7a.9.9 0 0 0 0 1.4L3.7 12 .2 15.6a.9.9 0 0 0 0 1.4l1.2 1.1a.9.9 0 0 0 1.2.1l4-3.1 9.3 8.5a1.4 1.4 0 0 0 1.6.3l4.9-2.3a1.4 1.4 0 0 0 .8-1.3V3.7a1.4 1.4 0 0 0-.8-1.3ZM17.6 7.5v9L11.6 12Z"
      fill="#007ACC"
      fillRule="evenodd"
    />
  </svg>
);

const Spotify: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="#1DB954" />
    <path d="M7.2 9.9c3.3-1 7-.7 9.8 1" stroke="#191414" strokeWidth="1.9" strokeLinecap="round" fill="none" />
    <path d="M7.7 12.8c2.8-.8 5.9-.5 8.2 1" stroke="#191414" strokeWidth="1.7" strokeLinecap="round" fill="none" />
    <path d="M8.2 15.5c2.2-.6 4.6-.4 6.4.8" stroke="#191414" strokeWidth="1.5" strokeLinecap="round" fill="none" />
  </svg>
);

const YouTube: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect x="2" y="5.5" width="20" height="13" rx="4" fill="#FF0000" />
    <path d="M10.3 9.1 15.6 12l-5.3 2.9z" fill="#fff" />
  </svg>
);

const GitHub: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      d="M12 2.2c-5.4 0-9.8 4.4-9.8 9.8 0 4.3 2.8 8 6.7 9.3.5.1.7-.2.7-.5v-1.9c-2.7.6-3.3-1.2-3.3-1.2-.4-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.2-4.5-1.1-4.5-4.9 0-1.1.4-2 1-2.7-.1-.2-.4-1.2.1-2.6 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.6.6.7 1 1.6 1 2.7 0 3.8-2.3 4.7-4.5 4.9.4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5a9.8 9.8 0 0 0 6.7-9.3c0-5.4-4.4-9.8-9.8-9.8z"
      fill="#181717"
    />
  </svg>
);

const Slack: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d="M5.1 15.2a2.1 2.1 0 1 1-2.1-2.1h2.1zm1 0a2.1 2.1 0 0 1 4.2 0v5.2a2.1 2.1 0 1 1-4.2 0z" fill="#E01E5A" />
    <path d="M8.8 5.1a2.1 2.1 0 1 1 2.1-2.1v2.1zm0 1a2.1 2.1 0 0 1 0 4.2H3.6a2.1 2.1 0 1 1 0-4.2z" fill="#36C5F0" />
    <path d="M18.9 8.8a2.1 2.1 0 1 1 2.1 2.1h-2.1zm-1 0a2.1 2.1 0 0 1-4.2 0V3.6a2.1 2.1 0 1 1 4.2 0z" fill="#2EB67D" />
    <path d="M15.2 18.9a2.1 2.1 0 1 1-2.1 2.1v-2.1zm0-1a2.1 2.1 0 0 1 0-4.2h5.2a2.1 2.1 0 1 1 0 4.2z" fill="#ECB22E" />
  </svg>
);

const Figma: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d="M12 2.5H8.4a3.4 3.4 0 0 0 0 6.8H12z" fill="#F24E1E" />
    <path d="M12 2.5h3.6a3.4 3.4 0 0 1 0 6.8H12z" fill="#FF7262" />
    <path d="M12 9.3H8.4a3.4 3.4 0 0 0 0 6.8H12z" fill="#A259FF" />
    <circle cx="15.6" cy="12.7" r="3.4" fill="#1ABCFE" />
    <path d="M12 16.1H8.4a3.4 3.4 0 1 0 3.6 3.4v-3.4z" fill="#0ACF83" />
  </svg>
);

const Notion: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect x="4.5" y="3" width="15" height="18" rx="2" fill="#fff" stroke="#111" strokeWidth="1.5" />
    <path d="M8.7 16.7V7.6l1.6-.1 4.3 6.4V7.5h1.8v9.2l-1.7.1-4.3-6.3v6.2z" fill="#111" />
  </svg>
);

const X: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect x="2.5" y="2.5" width="19" height="19" rx="4.5" fill="#050505" />
    <path
      d="M16.4 6.5h2.2l-4.9 5.6 5.7 8.6h-4.5l-3.5-5.3-4 5.3H4.9l5.2-6.4-5.5-7.8h4.6l3.2 4.7zM15.6 18.4h1.2L7.7 7.5H6.4z"
      fill="#e7e9ea"
      fillRule="evenodd"
    />
  </svg>
);

const Instagram: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="5" stroke="#E4405F" strokeWidth="2" fill="none" />
    <circle cx="12" cy="12" r="4.2" stroke="#E4405F" strokeWidth="2" fill="none" />
    <circle cx="17.2" cy="6.8" r="1.3" fill="#E4405F" />
  </svg>
);

const Twitch: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      d="M5 2.8 3.2 6.3V19h4.6v3.2L10.9 19h3.9l6-6V2.8H5zm12.9 9.1-2.9 2.9h-3.4l-2.9 2.9v-2.9H5.9V5.5h12v6.4z"
      fill="#9146FF"
      fillRule="evenodd"
    />
    <rect x="9.6" y="7.6" width="1.9" height="5" fill="#9146FF" />
    <rect x="13.3" y="7.6" width="1.9" height="5" fill="#9146FF" />
  </svg>
);

const Reddit: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle cx="12" cy="12.7" r="9" fill="#FF4500" />
    <path d="M12 6.9l4.3-2.2" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    <circle cx="17.1" cy="4.4" r="1.5" fill="#fff" />
    <circle cx="8.6" cy="11.6" r="1.45" fill="#fff" />
    <circle cx="15.4" cy="11.6" r="1.45" fill="#fff" />
    <path d="M8.4 14.9c1 1.3 2.3 2 3.6 2s2.6-.7 3.6-2" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" fill="none" />
  </svg>
);

const Steam: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="#1B2838" />
    <circle cx="8.6" cy="15.2" r="2.7" stroke="#66C0F4" strokeWidth="1.8" fill="none" />
    <path d="M10.5 13.3l4.4-4.4" stroke="#66C0F4" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="16.2" cy="7.6" r="1.9" fill="#66C0F4" />
  </svg>
);

const WhatsApp: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="#25D366" />
    <path d="M12 5.7a6.3 6.3 0 0 0-5.4 9.5l-1 3.5 3.6-.9A6.3 6.3 0 1 0 12 5.7z" fill="#fff" />
    <path
      d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.21c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"
      fill="#25D366"
      transform="translate(12 11.3) scale(0.42) translate(-12 -12)"
    />
  </svg>
);

const Telegram: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="#26A5E4" />
    <path
      d="M18.7 5.9 5.6 10.8c-.8.3-.8 1.5.1 1.7l3.2.8 1.2 3.9c.2.7 1.2.9 1.7.3l1.7-2 3.2 2.3c.6.5 1.5.1 1.6-.6l1.9-9.9c.2-.8-.7-1.5-1.5-1.3z"
      fill="#fff"
    />
  </svg>
);

const Zoom: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect x="2.5" y="7.2" width="13.4" height="9.6" rx="2.6" fill="#2D8CFF" />
    <path d="M16.9 10.9 21.3 8.3v7.4l-4.4-2.6z" fill="#2D8CFF" />
  </svg>
);

const Netflix: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d="M6.4 3h3.3v18H6.4z" fill="#E50914" />
    <path d="M14.3 3h3.3v18h-3.3z" fill="#E50914" />
    <path d="M6.4 3h3.3l7.9 18h-3.3z" fill="#E50914" />
  </svg>
);

const Gmail: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect x="3" y="5.5" width="18" height="13" rx="2" fill="#fff" />
    <rect x="3.6" y="7" width="2.6" height="11.5" fill="#4285F4" />
    <rect x="17.8" y="7" width="2.6" height="11.5" fill="#34A853" />
    <path d="M12 16.6 3.6 10V6.6L12 13.2l8.4-6.6V10z" fill="#EA4335" />
  </svg>
);

const GDrive: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d="M8.64 3.5 2 14.95l3.32 5.75L12 9.25z" fill="#00AC47" />
    <path d="M15.36 3.5 22 14.95l-3.32 5.75L12 9.25z" fill="#FFBA00" />
    <path d="M12 9.25 5.32 20.7h13.36z" fill="#2684FC" />
  </svg>
);

const Terminal: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect x="2.5" y="4" width="19" height="16" rx="2.5" fill="#171C26" />
    <path d="M6.4 8.9l4.2 3.3-4.2 3.3" stroke="#4AE168" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <path d="M12.9 15.5h5" stroke="#4AE168" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const Games: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      d="M7.5 7h9c3 0 5.5 2.6 5.5 5.8 0 2.4-1.6 4.2-3.6 4.2-1.2 0-2-.6-2.9-1.6-.6-.7-1-.9-2-.9h-3c-1 0-1.4.2-2 .9-.9 1-1.7 1.6-2.9 1.6-2 0-3.6-1.8-3.6-4.2C2 9.6 4.5 7 7.5 7z"
      fill="#7C5CFF"
    />
    <path d="M8.1 9.9h1.5v1.6h1.6V13H9.6v1.6H8.1V13H6.5v-1.5h1.6z" fill="#fff" />
    <circle cx="15.6" cy="13" r="1.15" fill="#fff" />
    <circle cx="17.7" cy="10.7" r="1.15" fill="#fff" />
  </svg>
);

const Docs: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d="M6.3 2.6h7.1L19 8.1v13.3H6.3z" fill="#4285F4" />
    <path d="M13.4 2.6 19 8.1h-5.6z" fill="#A8C7FA" />
    <rect x="9" y="11.2" width="6.6" height="1.5" fill="#fff" />
    <rect x="9" y="13.9" width="6.6" height="1.5" fill="#fff" />
    <rect x="9" y="16.6" width="4.2" height="1.5" fill="#fff" />
  </svg>
);

const Music: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d="M9.4 16.9V6.7l9.2-2.2v10.2" stroke="#E0619E" strokeWidth="2" strokeLinejoin="round" fill="none" />
    <ellipse cx="7.6" cy="16.9" rx="2.3" ry="1.8" fill="#E0619E" />
    <ellipse cx="16.4" cy="14.7" rx="2.3" ry="1.8" fill="#E0619E" />
  </svg>
);

const Edge: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="#0078D7" />
    <path
      d="M2.6 13.7c1.6-3 5.1-5 9-4.6 3.3.3 5.8 2.2 5.8 4.7 0 1.9-1.5 3.1-3.7 3.1-4.4 0-8.5-1.1-11.1-3.2z"
      fill="#fff"
    />
  </svg>
);

const Firefox: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      d="M12 2.2c1.6 1.9 2.3 3.9 2 6.2 1-.6 1.7-1.5 2-2.8 1.9 1.9 3 4.4 3 7.1A7 7 0 0 1 12 20a7.3 7.3 0 0 1-7.3-7.3C4.7 7.3 7.9 3.4 12 2.2z"
      fill="#FF7139"
    />
    <path
      d="M12 20a4.6 4.6 0 0 1-4.6-4.6c0-2.1 1.4-3.6 3-4.7.2 1 .8 1.8 1.8 2.2-.2-1.5.2-2.9 1.3-4.2 1.9 1.6 3.1 3.9 3.1 6.4A4.6 4.6 0 0 1 12 20z"
      fill="#FFF44F"
    />
  </svg>
);

const Safari: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="#006CFF" />
    <circle cx="12" cy="12" r="8" stroke="#EAF3FF" strokeWidth="1" opacity="0.85" fill="none" />
    <path d="M16.5 7.5 13.8 13.8 10.2 10.2z" fill="#FF3B30" />
    <path d="M7.5 16.5 10.2 10.2 13.8 13.8z" fill="#fff" />
  </svg>
);

const Linear: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="#5E6AD2" />
    <path d="M2 12.4 12.4 2" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
    <path d="M2.9 16.1 16.1 2.9" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
    <path d="M4.7 18.9 18.9 4.7" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

const ChatGPT: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="#10A37F" />
    <path d="M12 5.4 17.8 8.7v6.6L12 18.6 6.2 15.3V8.7z" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
    <path d="M12 9.2l3.4 5.8H8.6z" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
  </svg>
);

const Claude: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      d="M12 3.4v17.2M4.6 7.7l14.8 8.6M19.4 7.7 4.6 16.3"
      stroke="#D97757"
      strokeWidth="2.4"
      strokeLinecap="round"
      fill="none"
    />
  </svg>
);

const Cursor: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d="M12 3.3 19.6 7.6 12 11.9 4.4 7.6z" fill="#7FD4FF" />
    <path d="M4.4 8.7 12 13v8.2l-7.6-4.3z" fill="#00B0FF" />
    <path d="M19.6 8.7 12 13v8.2l7.6-4.3z" fill="#0080C9" />
  </svg>
);

const Codex: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="#10A37F" />
    <path d="M7.4 8.6l4.1 3.4-4.1 3.4" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <path d="M13.6 15.4h4.2" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const Copilot: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      d="M4.2 10.6C4.2 7 7 4.2 10.6 4.2h2.8c3.6 0 6.4 2.8 6.4 6.4v2.8c0 3.6-2.8 6.4-6.4 6.4h-2.8c-3.6 0-6.4-2.8-6.4-6.4z"
      fill="#1F9CF0"
    />
    <rect x="7.1" y="9.9" width="3.4" height="4.6" rx="1.7" fill="#fff" />
    <rect x="13.5" y="9.9" width="3.4" height="4.6" rx="1.7" fill="#fff" />
  </svg>
);

const Teams: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect x="2.8" y="6.2" width="12.6" height="11.6" rx="2.4" fill="#6264A7" />
    <path d="M5.9 9.4h6.4v1.9h-2.2v4.9H8.1v-4.9H5.9z" fill="#fff" />
    <circle cx="19" cy="7.8" r="2.6" fill="#6264A7" />
    <path d="M15.6 18.7c.3-2.7 1.7-4.3 3.4-4.3s3.1 1.6 3.4 4.3z" fill="#6264A7" />
  </svg>
);


/* 1.3 — more fallbacks for apps whose real icon could not be extracted */
const Explorer: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d="M2.5 6.5a1.5 1.5 0 0 1 1.5-1.5h5l2 2h9a1.5 1.5 0 0 1 1.5 1.5V9h-19z" fill="#E8A21B" />
    <rect x="2.5" y="8.6" width="19" height="10.9" rx="1.6" fill="#FFC83D" />
    <rect x="2.5" y="8.6" width="19" height="2.2" fill="#FFD866" />
    <rect x="6" y="13" width="12" height="2.4" rx="1" fill="#1E88E5" />
  </svg>
);
const officeTile = (bg: string, dark: string, letter: string): AppLogoComponent =>
  function Office({ size = 16, className }) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
        <rect x="7" y="3" width="14" height="18" rx="2.2" fill={bg} />
        <path d="M14 7h5M14 10.5h5M14 14h5M14 17.5h5" stroke="#fff" strokeOpacity=".55" strokeWidth="1.4" />
        <rect x="2.5" y="6.5" width="11" height="11" rx="1.8" fill={dark} />
        <text x="8" y="15.2" textAnchor="middle" fontSize="8.4" fontWeight="800" fill="#fff" fontFamily="Segoe UI, Arial, sans-serif">{letter}</text>
      </svg>
    );
  };
const Word = officeTile("#41A5EE", "#185ABD", "W");
const Excel = officeTile("#33C481", "#107C41", "X");
const PowerPoint = officeTile("#FF8F6B", "#C43E1C", "P");
const Outlook = officeTile("#28A8EA", "#0364B8", "O");
const Photoshop: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect x="2" y="2.5" width="20" height="19" rx="4.4" fill="#001E36" />
    <text x="12" y="16.2" textAnchor="middle" fontSize="10" fontWeight="800" fill="#31A8FF" fontFamily="Segoe UI, Arial, sans-serif">Ps</text>
  </svg>
);
const Obsidian: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d="M8.6 2.6 15.9 4l3.5 7.3-2.8 9.9-7.9.2-4.5-6.6 1.6-7.7z" fill="#7C3AED" />
    <path d="M8.6 2.6 9.9 9.6l-4.1 4.7 1.6-7.7z" fill="#A78BFA" />
    <path d="M15.9 4 9.9 9.6l6.7 11.6 2.8-9.9z" fill="#5B21B6" />
    <path d="M9.9 9.6 8.7 21.4l7.9-.2z" fill="#6D28D9" />
  </svg>
);
const OBS: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="#302E31" />
    <circle cx="12" cy="7.6" r="2.9" fill="#fff" />
    <circle cx="8.2" cy="14.3" r="2.9" fill="#fff" />
    <circle cx="15.8" cy="14.3" r="2.9" fill="#fff" />
    <circle cx="12" cy="12" r="2.1" fill="#302E31" />
  </svg>
);
const VLC: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d="M10.2 3h3.6l5.4 15.5H4.8z" fill="#FF8800" />
    <path d="M8.6 8.8h6.8l.9 2.7H7.7zM6.8 14h10.4l.9 2.6H5.9z" fill="#fff" />
    <rect x="3.2" y="18.2" width="17.6" height="2.8" rx="1.2" fill="#E85E00" />
  </svg>
);
const Notepad: AppLogoComponent = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect x="4" y="3.5" width="16" height="17.5" rx="2" fill="#5AB6F5" />
    <rect x="5.5" y="6.5" width="13" height="13" rx="1" fill="#fff" />
    <path d="M7.5 9.5h9M7.5 12.5h9M7.5 15.5h6" stroke="#5AB6F5" strokeWidth="1.3" />
    <path d="M7 2.5v3M11 2.5v3M15 2.5v3" stroke="#2B6CB0" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/* ----------------------------------------------------------------- map --- */

export const APP_LOGOS: Record<string, AppLogoComponent> = {
  discord: Discord,
  chrome: Chrome,
  vscode: VSCode,
  spotify: Spotify,
  youtube: YouTube,
  github: GitHub,
  slack: Slack,
  figma: Figma,
  notion: Notion,
  x: X,
  instagram: Instagram,
  twitch: Twitch,
  reddit: Reddit,
  steam: Steam,
  whatsapp: WhatsApp,
  telegram: Telegram,
  zoom: Zoom,
  netflix: Netflix,
  gmail: Gmail,
  gdrive: GDrive,
  terminal: Terminal,
  games: Games,
  docs: Docs,
  music: Music,
  edge: Edge,
  firefox: Firefox,
  safari: Safari,
  linear: Linear,
  chatgpt: ChatGPT,
  claude: Claude,
  cursor: Cursor,
  codex: Codex,
  copilot: Copilot,
  teams: Teams,
  explorer: Explorer,
  word: Word,
  excel: Excel,
  powerpoint: PowerPoint,
  outlook: Outlook,
  photoshop: Photoshop,
  obsidian: Obsidian,
  obs: OBS,
  vlc: VLC,
  notepad: Notepad,
};

export const LOGO_APPS: string[] = Object.keys(APP_LOGOS);

/** common app-name variants → canonical key (applied after spaces are stripped) */
const ALIAS: Record<string, string> = {
  browser: "chrome",
  webbrowser: "chrome",
  googlechrome: "chrome",
  visualstudiocode: "vscode",
  code: "vscode",
  vsc: "vscode",
  spotifymusic: "spotify",
  twitter: "x",
  openai: "chatgpt",
  gpt: "chatgpt",
  googledrive: "gdrive",
  drive: "gdrive",
  microsoftteams: "teams",
  claudeai: "claude",
  // 1.3: names Timelens derives from exe files / window titles
  fileexplorer: "explorer",
  windowsexplorer: "explorer",
  windowsterminal: "terminal",
  wt: "terminal",
  powershell: "terminal",
  cmd: "terminal",
  commandprompt: "terminal",
  microsoftedge: "edge",
  msedge: "edge",
  mozillafirefox: "firefox",
  adobephotoshop: "photoshop",
  obsstudio: "obs",
  obs64: "obs",
  microsoftword: "word",
  winword: "word",
  microsoftexcel: "excel",
  microsoftpowerpoint: "powerpoint",
  powerpnt: "powerpoint",
  microsoftoutlook: "outlook",
  vlcmediaplayer: "vlc",
  "notepad++": "notepad",
  youtubemusic: "youtube",
  steamwebhelper: "steam",
  whatsappdesktop: "whatsapp",
  telegramdesktop: "telegram",
  zoomus: "zoom",
};

export function appLogoFor(app: string): AppLogoComponent | null {
  const key = app.toLowerCase().trim().replace(/\s+/g, "");
  if (!key) return null;
  const mapped = ALIAS[key] ?? key;
  return APP_LOGOS[mapped] ?? null;
}

/* ------------------------------------------------------------- fallback -- */

const FALLBACK_COLORS = ["#7C5CFF", "#E0619E", "#4A9DF8", "#3FBF8F", "#E0A13D", "#54C2D8", "#B76AE0", "#D86A5A"];

/** generic rounded-square tile with the app's first letter in pixel type */
function FallbackLogo({ app, size = 16, className }: AppLogoProps & { app: string }): ReactElement {
  const name = app.trim() || "?";
  const letter = (name[0] || "?").toUpperCase();
  const hash = [...name].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="4.5" fill={FALLBACK_COLORS[hash % FALLBACK_COLORS.length]} />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="12"
        fontWeight="700"
        fill="#fff"
        fontFamily="'Silkscreen','Pixelify Sans',monospace"
      >
        {letter}
      </text>
    </svg>
  );
}

/** a real brand mark for a Timelens app / site name, or null (generic dock glyphs excluded) */
export function brandLogoFor(app: string): AppLogoComponent | null {
  const key = app.toLowerCase().trim().replace(/\s+/g, "");
  if (key === "games" || key === "docs" || key === "music") return null;
  return appLogoFor(app);
}

export function AppLogo({ app, size = 16, className }: { app: string; size?: number; className?: string }) {
  const logo = appLogoFor(app);
  if (logo) return createElement(logo, { size, className });
  return <FallbackLogo app={app} size={size} className={className} />;
}
