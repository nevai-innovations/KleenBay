export default function BillingView() {
return ( <div className="billing-page"> 


  <section className="billing-plan-card">
    <div className="billing-plan-heading">
      <div>
        <p className="billing-eyebrow">MONTHLY PLAN</p>
        <h2>₹599/month</h2>
        <span className="billing-status">Action Required</span>
      </div>
      <span className="billing-shield" aria-hidden="true">♧</span>
    </div>

    <div className="billing-details-grid">
      <div className="billing-detail">
        <span>PLAN STARTED</span>
        <strong>Not scheduled</strong>
      </div>
      <div className="billing-detail">
        <span>NEXT CHARGE</span>
        <strong>Not scheduled</strong>
      </div>
      <div className="billing-detail">
        <span>MODE</span>
        <strong>Live</strong>
      </div>
    </div>

    <div className="billing-authorization">
      <label>
        <input type="checkbox" />
        <strong>
          I authorise ₹599 every month with automatic renewal until I
          cancel. Cancellation takes effect at the end of the current
          paid billing cycle.
        </strong>
      </label>
      <p>GST is not charged.</p>
      <p>
        By continuing, I agree to the <a href="#terms">Terms</a>,{" "}
        <a href="#privacy">Privacy Policy</a>,{" "}
        <a href="#subscription">Subscription, Cancellation &amp; Refund Policy</a>,
        and <a href="#delivery">Service Delivery Policy</a>.
      </p>
    </div>

    <button className="billing-activate" type="button" disabled>
  Activate monthly plan
</button>
  </section>

  <section className="billing-plan-card">
    <div className="billing-plan-heading">
      <div>
        <p className="billing-eyebrow">YEARLY PLAN</p>
       <h2>₹6999/year</h2>
<p>Yearly subscription</p>
      </div>
    </div>

    <div className="billing-details-grid">
      <div className="billing-detail">
        <span>PLAN STARTED</span>
        <strong>Not scheduled</strong>
      </div>
      <div className="billing-detail">
        <span>NEXT CHARGE</span>
        <strong>Not scheduled</strong>
      </div>
      <div className="billing-detail">
        <span>MODE</span>
        <strong>Live</strong>
      </div>
    </div>

    <div className="billing-authorization">
      <label>
        <input type="checkbox" />
        <strong>
  I authorise ₹6999 every year with automatic renewal until I
  cancel. Cancellation takes effect at the end of the current
  paid billing cycle.
</strong>
      </label>
      <p>GST is not charged.</p>
      <p>
        By continuing, I agree to the <a href="#terms">Terms</a>,{" "}
        <a href="#privacy">Privacy Policy</a>,{" "}
        <a href="#subscription">Subscription, Cancellation &amp; Refund Policy</a>,
        and <a href="#delivery">Service Delivery Policy</a>.
      </p>
    </div>

    <button className="billing-activate" type="button" disabled>
      Activate yearly plan
    </button>
  </section>

  <section className="panel billing-history">
    <h2>Payment History</h2>
    <p>Your payment history will appear here.</p>
  </section>
</div>


);
}
