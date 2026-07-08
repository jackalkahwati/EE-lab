import { EnterpriseSidebar } from '@/components/enterprise-sidebar'

/** Enterprise console shell: fixed left icon drawer, content on the right. */
export default function EnterpriseLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex">
      <EnterpriseSidebar />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  )
}
