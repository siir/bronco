export interface Operator {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  notifyEmail: boolean;
  notifySlack: boolean;
  createdAt: Date;
  updatedAt: Date;
}
