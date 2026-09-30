import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	timeout: 90_000,
	use: {
		baseURL: 'http://localhost:4173',
		permissions: ['camera', 'microphone']
	},
	webServer: {
		command: 'pnpm build && pnpm preview --port 4173',
		port: 4173,
		reuseExistingServer: true
	},
	projects: [
		{
			name: 'chromium',
			use: {
				browserName: 'chromium',
				launchOptions: {
					args: [
						'--use-fake-device-for-media-stream',
						'--use-fake-ui-for-media-stream',
						'--autoplay-policy=no-user-gesture-required'
					]
				}
			}
		},
		{
			name: 'firefox',
			use: {
				browserName: 'firefox',
				launchOptions: {
					firefoxUserPrefs: {
						'media.navigator.streams.fake': true,
						'media.navigator.permission.disabled': true
					}
				}
			}
		},
		{ name: 'webkit', use: { browserName: 'webkit' } }
	]
});
