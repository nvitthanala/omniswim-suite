# OLED theme reference

The OLED preset uses pure black for `--bg`; no matching Orca terminal palette was found in the inspected settings/resources. The app resources contained only a terminal custom-theme schema, while the Orca settings baseline had `tui.theme: null`.

## Colors

| Token | Value | Source |
|---|---|---|
| `--bg` | `#000000` | Pure black; required fallback because palette was unavailable |
| `--surface` | `#08090b` | Slightly lifted neutral surface |
| `--surface-strong` | `#0f1114` | Raised neutral surface |
| `--surface-muted` | `#030405` | Near-black muted surface |
| `--border` | `#1c2026` | Subtle visible border |
| `--text-primary` | `#ffffff` | High contrast neutral |
| `--text-secondary` | `#d1d5db` | High contrast neutral |
| `--text-muted` | `#a1a1aa` | High contrast neutral |
| `--preset-accent` | `#f87171` | Suite coral accent (a pale grey accent made white button text unreadable) |

## WCAG contrast

Ratios use WCAG 2.x relative luminance. All body text combinations exceed 4.5:1.

| Text token | On `--bg` (`#000000`) | On `--surface` (`#08090b`) |
|---|---:|---:|
| `--text-primary` `#ffffff` | 21.00:1 | 19.92:1 |
| `--text-secondary` `#d1d5db` | 14.25:1 | 13.52:1 |
| `--text-muted` `#a1a1aa` | 8.19:1 | 7.77:1 |

## Screenshots

Playwright screenshots are saved here for Home, Manager, Matrix and Metrics when generation succeeds.

