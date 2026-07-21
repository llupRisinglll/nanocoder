export interface Colors {
	text: string;
	base: string;
	primary: string;
	tool: string;
	secondary: string;
	success: string;
	error: string;
	info: string;
	warning: string;
	// Diff highlight colors (line-level)
	diffAdded: string;
	diffRemoved: string;
	diffAddedText: string;
	diffRemovedText: string;
	// Diff highlight colors (word-level, more intense than line-level)
	diffAddedWord: string;
	diffRemovedWord: string;
	// Gradient colors (optional) — legacy palette metadata; NOT consumed by the
	// welcome banner (several stock themes define it)
	gradientColors?: string[];
	// Welcome-banner gradient override (optional); two identical stops render
	// the banner as a solid color. Absent = classic [primary, tool] gradient.
	bannerGradient?: string[];
	// Text-box background override (optional): 'none' renders boxes on the
	// terminal's own background instead of colors.base
	textboxBackground?: string;
	// Assistant icon (optional): when set, assistant replies render as
	// "<icon> text" with a hanging indent instead of the "model:" boxed block
	assistantIcon?: string;
	// Prompt character (optional): when set, the input and user messages render
	// as "<char> content" inside a rounded, borderless-fill box instead of the
	// left-border + "You:" block style
	promptChar?: string;
}

export interface Theme {
	name: string;
	displayName: string;
	colors: Colors;
	themeType: 'light' | 'dark';
}

export type ThemePreset =
	| 'omnicode'
	| 'tokyo-night'
	| 'synthwave-84'
	| 'forest-night'
	| 'material-ocean'
	| 'sunset-glow'
	| 'nord-frost'
	| 'rose-pine-dawn'
	| 'neon-jungle'
	| 'midnight-amethyst'
	| 'desert-mirage'
	| 'cherry-blossom'
	| 'electric-storm'
	| 'deep-sea'
	| 'volcanic-ash'
	| 'cyberpunk-mint'
	| 'dracula'
	| 'catppuccin-latte'
	| 'catppuccin-frappe'
	| 'catppuccin-macchiato'
	| 'catppuccin-mocha'
	| 'gruvbox-dark'
	| 'gruvbox-light'
	| 'solarized-dark'
	| 'solarized-light'
	| 'one-dark'
	| 'one-light'
	| 'monokai'
	| 'github-dark'
	| 'github-light'
	| 'rose-pine'
	| 'rose-pine-moon'
	| 'ayu-dark'
	| 'ayu-mirage'
	| 'ayu-light'
	| 'night-owl'
	| 'palenight'
	| 'horizon'
	| 'kanagawa'
	| 'aurora-borealis'
	| 'high-contrast-dark'
	| 'high-contrast-light'
	| 'everforest-dark'
	| 'everforest-light'
	| 'vscode-dark-plus'
	| 'vscode-light-plus'
	| 'darcula'
	| 'papercolor-light'
	| 'papercolor-dark'
	| 'amber-terminal'
	| 'poimandres';

export type NanocoderShape =
	| 'block'
	| 'slick'
	| 'tiny'
	| 'grid'
	| 'pallet'
	| 'shade'
	| 'simple'
	| 'simpleBlock'
	| '3d'
	| 'simple3d'
	| 'chrome'
	| 'huge'
	| 'fork';
