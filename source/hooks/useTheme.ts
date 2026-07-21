import {createContext, useContext} from 'react';
import {defaultTheme, getThemeColors} from '@/config/themes';
import type {Colors, ThemePreset} from '@/types/ui';

interface ThemeContextType {
	currentTheme: ThemePreset;
	colors: Colors;
	setCurrentTheme: (theme: ThemePreset) => void;
}

export const ThemeContext = createContext<ThemeContextType | null>(null);

export function useTheme(): ThemeContextType {
	const context = useContext(ThemeContext);
	if (!context) {
		throw new Error('useTheme must be used within a ThemeProvider');
	}
	return context;
}

// For low-level, generic components that may be rendered outside a
// ThemeProvider (e.g. in isolation by tests). Falls back to the default
// theme's colors instead of throwing.
export function useOptionalTheme(): ThemeContextType {
	const context = useContext(ThemeContext);
	if (!context) {
		return {
			currentTheme: defaultTheme,
			colors: getThemeColors(defaultTheme),
			setCurrentTheme: () => {},
		};
	}
	return context;
}
