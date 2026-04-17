// Kit import path discovered from @awesome.me/kit-9a8becfc3a/package.json exports map.
// The kit contains Pro Sharp Light icons at './icons/sharp/light'.
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  // Editing
  faPencil,
  faTrash,
  faTrashCan,
  faCopy,
  faClipboard,
  // Navigation
  faChevronUp,
  faChevronDown,
  faChevronLeft,
  faChevronRight,
  faArrowUp,
  faArrowDown,
  faArrowLeft,
  faArrowRight,
  faArrowUpRightFromSquare,
  faAnglesLeft,
  faAnglesRight,
  faHouse,
  faTurnDownRight,
  faBars,
  // Status
  faCheck,
  faCircleCheck,
  faXmark,
  faCircleXmark,
  faTriangleExclamation,
  faCircleInfo,
  faCircleQuestion,
  faCircle,
  faCircleDot,
  // Actions
  faArrowsRotate,
  faRotate,
  faMagnifyingGlass,
  faFilter,
  faSort,
  faPlus,
  faMinus,
  faEllipsis,
  faEllipsisVertical,
  faSpinner,
  faPlay,
  faPause,
  faStop,
  faDownload,
  faPaperPlaneTop,
  // Communication
  faEnvelope,
  faComment,
  faComments,
  faBell,
  faBellSlash,
  // Entities
  faUser,
  faRobot,
  faWrench,
  faGear,
  faCloud,
  faServer,
  faDatabase,
  faBook,
  faFileLines,
  faFolder,
  faFolderOpen,
  faBuilding,
  faTicket,
  // UI affordances
  faSquareCheck,
  faSquare,
  faStar,
  faSparkles,
  faBolt,
  faFlag,
  faTag,
  faTags,
  faLink,
  faLinkSlash,
  faLock,
  faLockOpen,
  faEye,
  faEyeSlash,
  faClock,
  faCalendar,
} from '@awesome.me/kit-9a8becfc3a/icons/sharp/light';

/**
 * Bronco icon registry.
 *
 * Import path: @awesome.me/kit-9a8becfc3a/icons/sharp/light
 * Discovered in Step 3 of the icon system foundation PR (refs #131). The kit
 * package @awesome.me/kit-9a8becfc3a contains the Pro Sharp Light icons
 * selected when the kit was created on fontawesome.com.
 *
 * Maps semantic Bronco names → FA icon definitions. Consumers reference
 * icons by semantic name via <app-icon name="edit" />, NEVER by importing
 * FA icons directly. This isolates the third-party library behind a single
 * file so swapping libraries later is a one-file change.
 *
 * To add a new icon:
 *   1. Import the fa* symbol from '@awesome.me/kit-9a8becfc3a/icons/sharp/light' above
 *   2. Add a key to ICON_REGISTRY with a semantic name (kebab-case)
 *   3. The IconName type updates automatically
 *
 * Naming guideline: use semantic intent, not the FA name. faPencil → "edit"
 * not "pencil". faTrash → "delete" not "trash".
 */
export const ICON_REGISTRY = {
  // Editing
  edit: faPencil,
  delete: faTrash,
  'delete-can': faTrashCan,
  copy: faCopy,
  clipboard: faClipboard,
  // Navigation
  'chevron-up': faChevronUp,
  'chevron-down': faChevronDown,
  'chevron-left': faChevronLeft,
  'chevron-right': faChevronRight,
  'arrow-up': faArrowUp,
  'arrow-down': faArrowDown,
  'arrow-left': faArrowLeft,
  'arrow-right': faArrowRight,
  'external-link': faArrowUpRightFromSquare,
  'skip-left': faAnglesLeft,
  'skip-right': faAnglesRight,
  back: faArrowLeft,
  home: faHouse,
  subdirectory: faTurnDownRight,
  menu: faBars,
  // Status
  check: faCheck,
  'check-circle': faCircleCheck,
  close: faXmark,
  'close-circle': faCircleXmark,
  warning: faTriangleExclamation,
  info: faCircleInfo,
  question: faCircleQuestion,
  pending: faCircle,
  active: faCircleDot,
  // Actions
  refresh: faArrowsRotate,
  rotate: faRotate,
  search: faMagnifyingGlass,
  filter: faFilter,
  sort: faSort,
  add: faPlus,
  remove: faMinus,
  more: faEllipsis,
  'more-vertical': faEllipsisVertical,
  spinner: faSpinner,
  play: faPlay,
  pause: faPause,
  stop: faStop,
  download: faDownload,
  send: faPaperPlaneTop,
  // Communication
  email: faEnvelope,
  comment: faComment,
  comments: faComments,
  bell: faBell,
  'bell-off': faBellSlash,
  // Entities
  user: faUser,
  robot: faRobot,
  wrench: faWrench,
  gear: faGear,
  cloud: faCloud,
  server: faServer,
  database: faDatabase,
  book: faBook,
  file: faFileLines,
  folder: faFolder,
  'folder-open': faFolderOpen,
  building: faBuilding,
  ticket: faTicket,
  // UI affordances
  'square-check': faSquareCheck,
  square: faSquare,
  star: faStar,
  sparkles: faSparkles,
  bolt: faBolt,
  flag: faFlag,
  tag: faTag,
  tags: faTags,
  link: faLink,
  'link-broken': faLinkSlash,
  lock: faLock,
  unlock: faLockOpen,
  visible: faEye,
  hidden: faEyeSlash,
  clock: faClock,
  calendar: faCalendar,
} as const satisfies Record<string, IconDefinition>;

export type IconName = keyof typeof ICON_REGISTRY;
