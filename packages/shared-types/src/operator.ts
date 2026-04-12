export interface Operator {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  isAdmin: boolean;
  notifyEmail: boolean;
  notifySlack: boolean;
  slackUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
