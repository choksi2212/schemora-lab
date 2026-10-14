import type { Metadata } from 'next';
import { AccountSettings } from '@/components/account-settings';

export const metadata: Metadata = { title: 'Account settings' };

export default function AccountPage() {
  return <AccountSettings />;
}
