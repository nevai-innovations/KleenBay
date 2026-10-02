const pages = {
  '/terms': 'Terms of Service',
  '/privacy': 'Privacy Policy',
  '/subscription-policy': 'Subscription and Cancellation Policy',
  '/refund-policy': 'Refund Policy',
  '/delivery-policy': 'Service Delivery Policy',
} as const;

export function isLegalPath(path: string): path is keyof typeof pages { return path in pages; }

export function LegalView({ path }: { path: keyof typeof pages }) {
  return <main className="login-page"><div className="login-box legal-page"><a href="/">KleenBay</a><h1>{pages[path]}</h1><p>Final policy text is pending legal approval. This page is a stage placeholder and does not state final commercial terms.</p><a href="/billing">Back to Billing</a></div></main>;
}
