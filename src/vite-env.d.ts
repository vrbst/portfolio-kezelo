/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  /** Google OAuth client id (Web application) for the Drive sync; empty = off. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}
