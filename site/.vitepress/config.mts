import { defineConfig, type Plugin } from 'vitepress';

// Inline GitHub mark (Octicons, MIT): bundled so no icon service is ever contacted.
const GITHUB_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

// VitePress's default theme falls back to fetching unknown social icons from api.iconify.design.
// We only use inline SVGs, so remove that remote fallback from the bundle entirely.
const noRemoteIcons = (): Plugin => ({
  name: 'foxfleet-no-remote-icons', enforce: 'pre',
  transform(code, id) {
    if (!/VPSocialLink\.vue/.test(id) || !code.includes('api.iconify.design')) return null;
    return code.replace(/url\('https:\/\/api\.iconify\.design\/simple-icons\/\$\{[^}]+\}\.svg'\)/, "none");
  },
});

const repo = 'https://github.com/TinkerDoge/FoxFleet';

export default defineConfig({
  title: 'Foxfleet',
  description: 'Self-hosted hub, web app and Android app for talking to all your AI agents from one calm place.',
  base: '/FoxFleet/',
  lang: 'en',
  cleanUrls: true,
  lastUpdated: false,
  srcExclude: ['README.md', 'node_modules/**'],
  vite: { plugins: [noRemoteIcons()] },
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/FoxFleet/favicon.png' }],
    ['meta', { name: 'theme-color', content: '#BE4A21' }],
    ['meta', { property: 'og:title', content: 'Foxfleet docs' }],
    ['meta', { property: 'og:image', content: 'https://tinkerdoge.github.io/FoxFleet/img/web-chat.png' }],
  ],
  themeConfig: {
    logo: { light: '/wordmark-light.png', dark: '/wordmark-dark.png', alt: 'Foxfleet' },
    siteTitle: false,
    search: { provider: 'local' },
    editLink: { pattern: `${repo}/edit/main/site/:path`, text: 'Edit this page on GitHub' },
    socialLinks: [{ icon: { svg: GITHUB_SVG }, link: repo, ariaLabel: 'Foxfleet on GitHub' }],
    nav: [
      { text: 'Get started', link: '/guide/quick-start' },
      { text: 'Concepts', link: '/concepts/' },
      { text: 'Host it', link: '/hosting/' },
      { text: 'Agents', link: '/agents/' },
      { text: 'Apps', link: '/apps/chat' },
      { text: 'Reference', link: '/reference/api' },
      { text: 'More', items: [
        { text: 'Security', link: '/security/' },
        { text: 'Roadmap', link: '/project/roadmap' },
        { text: 'Changelog', link: '/project/changelog' },
        { text: 'Contributing', link: '/project/contributing' },
        { text: 'FAQ and troubleshooting', link: '/faq' },
        { text: 'Support and credits', link: '/support' },
      ] },
    ],
    sidebar: {
      '/guide/': [{ text: 'Getting started', items: [
        { text: '5-minute quick start', link: '/guide/quick-start' },
        { text: 'First run: the owner account', link: '/guide/first-run' },
        { text: 'Install the Android app', link: '/guide/android' },
      ] }],
      '/concepts/': [{ text: 'Concepts', items: [
        { text: 'Overview', link: '/concepts/' },
        { text: 'Accounts and roles', link: '/concepts/accounts' },
        { text: 'Agents, kinds and capabilities', link: '/concepts/agents' },
        { text: 'The connector', link: '/concepts/connector' },
        { text: 'Sessions and devices', link: '/concepts/sessions-devices' },
      ] }],
      '/hosting/': [{ text: 'Hosting', items: [
        { text: 'Overview', link: '/hosting/' },
        { text: 'Linux with systemd', link: '/hosting/systemd' },
        { text: 'Docker Compose', link: '/hosting/docker' },
        { text: 'Cloudflare Tunnel', link: '/hosting/cloudflare-tunnel' },
        { text: 'Caddy and nginx', link: '/hosting/reverse-proxy' },
        { text: 'Environment variables', link: '/hosting/environment' },
        { text: 'Data directory', link: '/hosting/data' },
        { text: 'Backups and restore', link: '/hosting/backups' },
        { text: 'Upgrading and rollback', link: '/hosting/upgrading' },
        { text: 'Resource sizing', link: '/hosting/sizing' },
        { text: 'Migrating from AgentsHub', link: '/hosting/migrating' },
      ] }],
      '/agents/': [{ text: 'Onboarding agents', items: [
        { text: 'Overview', link: '/agents/' },
        { text: 'Connect a real-machine agent', link: '/agents/real-machine' },
        { text: 'Hermes', link: '/agents/hermes' },
        { text: 'OpenAI-compatible', link: '/agents/openai' },
        { text: 'OpenRouter', link: '/agents/openrouter' },
        { text: 'Z.ai (GLM)', link: '/agents/zai' },
        { text: 'OpenCode', link: '/agents/opencode' },
        { text: 'Grok (xAI)', link: '/agents/grok' },
        { text: 'MCP inbox', link: '/agents/mcp-inbox' },
        { text: 'Screen takeover setup', link: '/agents/screen-setup' },
        { text: 'Write your own plugin', link: '/agents/write-a-plugin' },
      ] }],
      '/apps/': [{ text: 'Using the apps', items: [
        { text: 'Chat', link: '/apps/chat' },
        { text: 'Attachments and voice', link: '/apps/attachments' },
        { text: 'Commands', link: '/apps/commands' },
        { text: 'Media viewer', link: '/apps/media-viewer' },
        { text: 'Screen takeover', link: '/apps/screen' },
        { text: 'Admin', link: '/apps/admin' },
        { text: 'Settings and devices', link: '/apps/settings' },
        { text: 'Avatars', link: '/apps/avatars' },
      ] }],
      '/security/': [{ text: 'Security', items: [
        { text: 'Overview and threat model', link: '/security/' },
        { text: 'Authentication', link: '/security/auth' },
        { text: 'Secrets and privacy', link: '/security/secrets' },
        { text: 'Media proxy (SSRF)', link: '/security/media-proxy' },
        { text: 'Takeover safeguards', link: '/security/takeover' },
        { text: 'Reporting a problem', link: '/security/reporting' },
      ] }],
      '/reference/': [{ text: 'Reference', items: [
        { text: 'REST API', link: '/reference/api' },
        { text: 'Connector protocol', link: '/reference/connector-protocol' },
        { text: 'config.json (v3)', link: '/reference/config-json' },
        { text: 'Error codes', link: '/reference/errors' },
        { text: 'Environment variables', link: '/hosting/environment' },
      ] }],
      '/project/': [{ text: 'Project', items: [
        { text: 'Roadmap', link: '/project/roadmap' },
        { text: 'Changelog', link: '/project/changelog' },
        { text: 'Contributing', link: '/project/contributing' },
        { text: 'Development', link: '/project/development' },
        { text: 'Design tokens', link: '/project/design-tokens' },
        { text: 'Accessibility', link: '/project/accessibility' },
        { text: 'Release process', link: '/project/release' },
      ] }],
    },
    footer: { message: 'MIT licensed. Free software with optional tips.', copyright: 'Foxfleet contributors' },
    outline: { level: [2, 3] },
  },
});
