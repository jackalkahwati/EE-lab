import Link from "next/link";

export const metadata = { title: "Privacy Policy — FirstLight" };

export default function Privacy() {
  return (
    <main className="legal-page" id="main-content">
      <div className="container narrow">
        <p className="kicker">StarDrive Inc.</p>
        <h1>Privacy Policy</h1>
        <p className="legal-updated">Last updated: July 17, 2026</p>

        <p>
          This Privacy Policy describes how StarDrive Inc. (&ldquo;StarDrive,&rdquo;
          &ldquo;we,&rdquo; &ldquo;us&rdquo;) collects, uses, and shares information
          in connection with the FirstLight website, the FirstLight Compose platform,
          and FL-1 hardware reservations (together, the &ldquo;Services&rdquo;). For
          individuals in the European Economic Area (&ldquo;EEA&rdquo;) and the United
          Kingdom, StarDrive Inc. is the data controller of your personal data.
        </p>

        <h2>1. Information We Collect</h2>
        <p>
          <strong>Account data:</strong> your email address and a salted hash of your
          password (never the password itself), or your email as verified by Google
          sign-in.{" "}
          <strong>Usage data:</strong> board descriptions you submit, generated design
          artifacts, run history, and plan and quota status.{" "}
          <strong>Contact and lead data:</strong> if you submit our &ldquo;Talk to
          us&rdquo; form or email us, we collect your name, email, company, and the
          message you send.{" "}
          <strong>Reservation and payment data:</strong> payments are handled entirely
          by Stripe; we receive a subscription or reservation status, a customer
          reference, and, for FL-1 reservations, the billing address Stripe collects.
          We never receive full card numbers.{" "}
          <strong>Technical data:</strong> standard server logs (IP address,
          timestamps, and request metadata) used for security and operations.
        </p>

        <h2>2. Bring-Your-Own-Key AI</h2>
        <p>
          If you configure a personal AI provider API key, it is used only to
          authenticate your own requests to that provider. Where a key is stored for
          your convenience, it is stored encrypted and never used for our own
          purposes. We do not sell or share your provider keys.
        </p>

        <h2>3. How We Use Information</h2>
        <p>
          We use information to operate and secure the Services: generating designs,
          maintaining your run history, enforcing plan limits, processing
          subscriptions and reservations, responding to your inquiries, following up
          on sales leads, and preventing abuse. Board descriptions are processed by
          third-party AI model providers (such as Anthropic, or the provider whose key
          you supply) to power the design interview, reviews, and diagnosis. Component
          lookups may be sent to distributor APIs (such as DigiKey, Mouser, or
          Octopart) without your identity attached.
        </p>

        <h2>4. How We Share Information (Sub-processors)</h2>
        <p>
          We do not sell your personal information. We share it only with service
          providers who process it on our behalf under contract, and only as needed to
          run the Services:
        </p>
        <ul className="doc-list">
          <li><strong>Stripe</strong> — payment processing for subscriptions and reservations.</li>
          <li><strong>Google</strong> — sign-in (OAuth), and Google Sheets/Drive, where we record contact-form leads in our internal CRM.</li>
          <li><strong>Resend</strong> — transactional and notification email (for example, confirming your inquiry).</li>
          <li><strong>AI model providers</strong> (such as Anthropic) — to generate and review designs.</li>
          <li><strong>Component distributors</strong> (DigiKey, Mouser, Octopart) — de-identified part lookups.</li>
          <li><strong>Vercel</strong> — hosting for the FirstLight website.</li>
          <li><strong>Cloudflare</strong> — DNS, network security, and content delivery.</li>
          <li>A <strong>dedicated application server located in the European Union</strong>, which hosts the Compose platform and your account and run data.</li>
        </ul>
        <p>
          We may also disclose information if required by law, to protect our rights,
          or in connection with a merger or acquisition. Your private designs are
          visible only to your account unless you choose to share them, and we do not
          use them to train foundation models or to market to third parties.
        </p>

        <h2>5. International Data Transfers</h2>
        <p>
          We operate from the United States, and several of our sub-processors are
          based in the United States, while our application server is in the European
          Union. Where personal data of EEA or UK individuals is transferred to the
          United States or elsewhere, we rely on appropriate safeguards such as the
          European Commission&rsquo;s Standard Contractual Clauses (and the UK
          Addendum) or another lawful transfer mechanism offered by the relevant
          provider.
        </p>

        <h2>6. Cookies</h2>
        <p>
          We use a session cookie to keep you signed in and short-lived cookies during
          Google sign-in and Stripe checkout. These are strictly necessary to provide
          the Services. We do not use third-party advertising or cross-site tracking
          cookies.
        </p>

        <h2>7. Data Retention and Deletion</h2>
        <p>
          Account and run data are retained while your account is active. Contact and
          lead data are retained while we evaluate or pursue a business relationship,
          and afterward for a reasonable period unless you ask us to delete it.
          Payment records are retained as required for tax and accounting. Email{" "}
          <a href="mailto:jack@thestardrive.com">jack@thestardrive.com</a> to request
          deletion of your account, lead record, and associated data; we will honor
          verified requests within 30 days, subject to legal retention obligations.
        </p>

        <h2>8. Your Rights (EEA and UK)</h2>
        <p>
          If you are in the EEA or the UK, you have the right to access, correct,
          delete, restrict, or object to our processing of your personal data, to data
          portability, and to withdraw consent where processing is based on consent.
          We process your data on the following legal bases: performance of a contract
          (providing the Services and processing your subscription or reservation);
          our legitimate interests (securing the platform, improving the Services, and
          responding to and following up on inquiries); consent (where we ask for it);
          and compliance with legal obligations (such as tax records). To exercise any
          right, email{" "}
          <a href="mailto:jack@thestardrive.com">jack@thestardrive.com</a>. You also
          have the right to lodge a complaint with your local data protection
          supervisory authority.
        </p>

        <h2>9. Your Rights (California)</h2>
        <p>
          If you are a California resident, you have the right to know what personal
          information we collect and how we use it, to request access to or deletion of
          your personal information, and to correct inaccurate information. We do not
          sell or share your personal information as those terms are defined under the
          California Consumer Privacy Act, and we will not discriminate against you for
          exercising your rights. To make a request, email{" "}
          <a href="mailto:jack@thestardrive.com">jack@thestardrive.com</a>.
        </p>

        <h2>10. Security</h2>
        <p>
          Passwords are hashed (scrypt), sessions are signed, transport is encrypted
          in transit, and access to run artifacts requires authentication. No system
          is perfectly secure; please use a unique password.
        </p>

        <h2>11. Children</h2>
        <p>
          The Services are intended for business use by adults and are not directed to
          anyone under 18. We do not knowingly collect personal data from children.
        </p>

        <h2>12. Changes</h2>
        <p>
          We may update this policy; material changes will be posted here with an
          updated date.
        </p>

        <h2>Contact</h2>
        <p>
          StarDrive Inc., 1400 Mission St. #214, San Francisco, CA 94103, USA.{" "}
          <a href="mailto:jack@thestardrive.com">jack@thestardrive.com</a>
        </p>

        <p>
          <Link href="/" className="compose-link">&larr; Back to FirstLight</Link>
        </p>
      </div>
    </main>
  );
}
