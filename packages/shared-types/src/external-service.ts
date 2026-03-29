export const ExternalServiceCheckType = {
  HTTP: 'HTTP',
  OLLAMA: 'OLLAMA',
  DOCKER: 'DOCKER',
} as const;
export type ExternalServiceCheckType =
  (typeof ExternalServiceCheckType)[keyof typeof ExternalServiceCheckType];

export interface ExternalServiceRecord {
  id: string;
  name: string;
  endpoint: string;
  checkType: ExternalServiceCheckType;
  isMonitored: boolean;
  timeoutMs: number;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}
