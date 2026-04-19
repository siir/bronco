export interface Person {
  id: string;
  name: string;
  email: string;
  emailLower: string;
  phone: string | null;
  passwordHash: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
