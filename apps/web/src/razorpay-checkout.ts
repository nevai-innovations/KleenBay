export type CheckoutResponse = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
export type CheckoutOptions = { key: string; order_id: string; amount: number; currency: string; name: string; description: string; prefill: { name?: string; email?: string }; handler: (response: CheckoutResponse) => void; modal: { ondismiss: () => void }; theme: { color: string } };
export type CheckoutInstance = { open: () => void; on: (event: 'payment.failed', callback: () => void) => void };
declare global { interface Window { Razorpay?: new (options: CheckoutOptions) => CheckoutInstance } }
let loading: Promise<void> | undefined;

export async function openRazorpay(options: CheckoutOptions, onFailure: () => void) {
  if (!window.Razorpay) {
    loading ??= new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      const timeout = window.setTimeout(() => fail(), 15000);
      function fail() { window.clearTimeout(timeout); loading = undefined; script.remove(); reject(new Error('Could not load Razorpay Checkout. Please try again.')); }
      script.onload = () => { window.clearTimeout(timeout); if (window.Razorpay) resolve(); else fail(); };
      script.onerror = fail;
      document.head.append(script);
    });
    await loading;
  }
  if (!window.Razorpay) throw new Error('Razorpay Checkout is unavailable');
  const checkout = new window.Razorpay(options);
  checkout.on('payment.failed', onFailure);
  checkout.open();
}
