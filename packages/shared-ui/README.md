# @bronco/shared-ui

Shared Angular component library providing common UI components used across Bronco applications (Finance, Meal Planner, Control Panel, YouTube Manager).

## Components

### AppSwitcherComponent

Navigation component that allows users to switch between Bronco applications. Used in sidenav headers across all Angular apps.

## Usage

```typescript
import { AppSwitcherComponent } from '@bronco/shared-ui';

@Component({
  imports: [AppSwitcherComponent],
  template: `<rc-app-switcher />`
})
```

## Peer Dependencies

- `@angular/common` ≥19.0.0
- `@angular/core` ≥19.0.0
- `@angular/material` ≥19.0.0

## Development

This is a library package — it does not run standalone. Changes are picked up by consuming apps during their build.

```bash
# Build the library
cd packages/shared-ui
pnpm build
```
