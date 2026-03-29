export const ReleaseNoteType = {
  FEATURE: 'FEATURE',
  FIX: 'FIX',
  MAINTENANCE: 'MAINTENANCE',
  OTHER: 'OTHER',
} as const;
export type ReleaseNoteType = (typeof ReleaseNoteType)[keyof typeof ReleaseNoteType];

export interface ReleaseNote {
  id: string;
  commitSha: string;
  commitDate: string;
  rawMessage: string;
  summary: string | null;
  services: string[];
  changeType: ReleaseNoteType;
  isVisible: boolean;
  createdAt: string;
}
