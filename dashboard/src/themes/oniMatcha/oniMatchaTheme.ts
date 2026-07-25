/**
 * Oni Matcha Theme
 *
 * Matcha's structure (typography, motion, radius, icon registry) recolored
 * with the "Ember" palette from the astryx-redesigns sandbox — the wallpaper
 * match: near-black ground / cream paper, burnt-orange accent, ink text.
 * Unlike the sandbox's dark-only Ember/Gothic themes, this one carries both
 * light AND dark tuples (matcha supports light mode, and the app's existing
 * light/dark toggle should keep driving both shadcn and Astryx components).
 *
 * `extends: matchaTheme` inherits typography (Playwrite US Trad heading / DM
 * Sans body), motion, spacing, radius (soft/rounded — matcha's actual shape,
 * not the sandbox's sharp-cornered Ember geometry), component overrides, and
 * icons for free. Only color tokens are overridden here.
 */

import { defineTheme, defineSyntaxTheme } from '@astryxdesign/core/theme';
import { matchaTheme } from '../matcha/matchaTheme';

// Ember-recolored syntax palette — replaces matcha's greens so CodeBlock/
// Markdown don't read as a leftover different theme.
const emberSyntax = defineSyntaxTheme({
  name: 'xds-oni-ember',
  tokens: {
    keyword: ['#A8431F', '#E8926B'],
    string: ['#5A6B2A', '#9DBF7A'],
    comment: ['#8A7A6B', '#7A6B5D'],
    number: ['#8C6B30', '#D4B870'],
    function: ['#3A5E8C', '#8FB4D8'],
    type: ['#6B4A8C', '#B99AD6'],
    variable: ['#1A1512', '#F3ECE2'],
    operator: ['#6B5D51', '#B3A497'],
    constant: ['#8C6B30', '#D4B870'],
    tag: ['#A8431F', '#E8926B'],
    attribute: ['#7C5E3A', '#C4A882'],
    property: ['#3A7C6B', '#70C4B0'],
    punctuation: ['#8A7A6B', '#6B5D51'],
    background: ['#FBF7F1', '#131110'],
  },
});

export const oniMatchaTheme = defineTheme({
  name: 'oni-matcha',
  extends: matchaTheme,
  syntax: emberSyntax,
  tokens: {
    // ---- accent: burnt-orange ember -------------------------------------
    // Light mode uses a darker ember (#A8431F) so accent text clears AA on
    // cream. Dark mode splits fill (#C2542B) from accent text/icon
    // (#E8926B) — #C2542B on #0A0908 is only ~4.3:1, fine as a filled
    // surface but not for body-sized text.
    '--color-accent': ['#A8431F', '#C2542B'],
    '--color-accent-muted': ['#A8431F1F', '#C2542B33'],
    '--color-text-accent': ['#8F3818', '#E8926B'],
    '--color-icon-accent': ['#A8431F', '#E8926B'],
    '--color-on-accent': ['#FFFFFF', '#FFFFFF'],

    // ---- surfaces: cream paper / near-black ground ----------------------
    '--color-background-body': ['#F3ECE2', '#0A0908'],
    '--color-background-surface': ['#FBF7F1', '#131110'],
    '--color-background-card': ['#FFFFFF', '#17140F'],
    '--color-background-popover': ['#FFFFFF', '#1C1712'],
    '--color-background-muted': ['#EDE4D8', '#1A1613'],
    '--color-background-inverted': ['#1A1512', '#F3ECE2'],

    // ---- text -------------------------------------------------------------
    '--color-text-primary': ['#1A1512', '#F3ECE2'],
    '--color-text-secondary': ['#6B5D51', '#B3A497'],
    '--color-text-disabled': ['#A0907F', '#5C5045'],
    '--color-on-dark': '#F3ECE2',
    '--color-on-light': '#1A1512',

    // ---- icon ---------------------------------------------------------------
    '--color-icon-primary': ['#1A1512', '#F3ECE2'],
    '--color-icon-secondary': ['#6B5D51', '#B3A497'],
    '--color-icon-disabled': ['#A0907F', '#5C5045'],

    // ---- border -------------------------------------------------------------
    '--color-border': ['#E0D5C6', 'rgba(243,236,226,0.09)'],
    '--color-border-emphasized': ['#C9B9A6', '#3A2E22'],

    // ---- effects — must override: matcha bakes #3E481D directly into all
    // of these rather than deriving from --color-accent, so they'd leak
    // matcha green through untouched otherwise.
    '--color-neutral': ['#1A15120F', '#F3ECE21A'],
    '--color-overlay': ['#1A151280', '#0A0908CC'],
    '--color-overlay-hover': ['#1A15120D', '#F3ECE20D'],
    '--color-overlay-pressed': ['#1A15121A', '#F3ECE21A'],
    '--color-skeleton': ['#E6DBCC', '#241E17'],
    '--color-shadow': ['#1A15121A', '#0000006B'],
    '--color-tint-hover': ['black', 'white'],
    '--shadow-low': '0 2px 4px #1A15120D, 0 4px 8px #1A15121A',
    '--shadow-med': '0 2px 4px #1A15120D, 0 4px 12px #1A15121F',
    '--shadow-high': '0 4px 6px #1A15121A, 0 12px 24px #1A151229',
    '--shadow-inset-hover': 'inset 0px 0px 0px 2px #C2542B33',
    '--shadow-inset-selected': 'inset 0px 0px 0px 2px #C2542B66',
    '--shadow-inset-success': 'inset 0px 0px 0px 2px #4A7C3F50',
    '--shadow-inset-warning': 'inset 0px 0px 0px 2px #B8860B50',
    '--shadow-inset-error': 'inset 0px 0px 0px 2px #C6323B50',

    // ---- categorical gray is matcha-green baked in; retint neutral -------
    '--color-background-gray': ['#6B5D5126', '#B3A49726'],
    '--color-border-gray': ['#6B5D51', '#B3A497'],
    '--color-icon-gray': ['#6B5D51', '#B3A497'],
    '--color-text-gray': ['#1A1512', '#F3ECE2'],

    // Warm the success/warning ramps so status chips read as one theme;
    // error stays a true red — it must remain unmistakable.
    '--color-success': ['#4A7C3F', '#7FBF6A'],
    '--color-success-muted': ['#4A7C3F20', '#7FBF6A20'],
    '--color-warning': ['#B8860B', '#E0A93A'],
    '--color-warning-muted': ['#B8860B20', '#E0A93A20'],
    '--color-error': ['#C6323B', '#E5484D'],
    '--color-error-muted': ['#C6323B20', '#E5484D20'],
  },
});
