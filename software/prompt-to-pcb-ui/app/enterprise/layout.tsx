import { EnterpriseSidebar } from '@/components/enterprise-sidebar'

/** Enterprise console shell: mobile navigation above content, desktop rail beside it. */
export default function EnterpriseLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col sm:flex-row">
      <EnterpriseSidebar />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  )
}
