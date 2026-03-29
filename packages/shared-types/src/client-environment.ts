export interface ClientEnvironment {
  id: string;
  clientId: string;
  name: string;
  tag: string;
  description: string | null;
  operationalInstructions: string | null;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}
