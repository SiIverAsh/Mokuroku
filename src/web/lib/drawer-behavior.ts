export interface OutsideClickTargetLike {
  isConnected: boolean;
  closest: (selector: string) => unknown | null;
}

export interface DrawerElementLike {
  contains: (node: unknown) => boolean;
}

const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, label, [role="button"]';

/**
 * Determines whether a window-level click should close the right-side SubjectDrawer,
 * allowing main-page wheel scrolling and direct row-to-row subject switching while open.
 */
export function shouldCloseDrawerOnWindowClick(
  subjectId: number | null,
  target: OutsideClickTargetLike | null,
  drawerPanelEl: DrawerElementLike | null
): boolean {
  if (subjectId === null) return false;
  if (!target || !target.isConnected) return false;
  if (drawerPanelEl?.contains(target)) return false;
  if (target.closest('[data-subject-trigger]')) return false;
  if (target.closest(INTERACTIVE_SELECTOR)) return false;
  return true;
}
