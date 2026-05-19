// Renders the lifecycle-state hero per the unify-confirmation-into-tracking proposal (2026-05-19). One of three states drives the illustration + headline.

import { cn } from "@/lib/utils";

interface StateHeroProps {
  lifecycleState: "pre-dropoff" | "post-dropoff" | "post-delivery";
  headline?: string;
  subtitle?: string;
}

function PreDropoffSvg() {
  return (
    <svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="h-16">
      <ellipse cx="100" cy="92" rx="48" ry="5" fill="rgba(20,40,80,0.10)"/>
      <g transform="translate(58,30)">
        <path d="M0 18 L36 0 L36 44 L0 62 Z" fill="#c98e3e" stroke="#7d5520" strokeWidth="1.2" strokeLinejoin="round"/>
        <path d="M0 18 L36 0 L72 18 L36 36 Z" fill="#e5b06b" stroke="#7d5520" strokeWidth="1.2" strokeLinejoin="round"/>
        <path d="M36 36 L72 18 L72 62 L36 80 Z" fill="#b97c34" stroke="#7d5520" strokeWidth="1.2" strokeLinejoin="round"/>
        <path d="M36 4 L36 32" stroke="#a26a26" strokeWidth="2" strokeDasharray="3 2"/>
        <rect x="14" y="10" width="32" height="20" rx="2" transform="skewY(-26)" fill="white" stroke="#214b91" strokeWidth="1"/>
        <line x1="14" y1="13" x2="46" y2="13" transform="skewY(-26)" stroke="#214b91" strokeWidth="0.8"/>
        <line x1="14" y1="17" x2="40" y2="17" transform="skewY(-26)" stroke="#666" strokeWidth="0.5"/>
        <line x1="14" y1="20" x2="38" y2="20" transform="skewY(-26)" stroke="#666" strokeWidth="0.5"/>
        <g transform="skewY(-26) translate(14, 23)">
          <rect x="0" y="0" width="1" height="4" fill="black"/><rect x="2" y="0" width="2" height="4" fill="black"/><rect x="5" y="0" width="1" height="4" fill="black"/><rect x="7" y="0" width="1.5" height="4" fill="black"/><rect x="10" y="0" width="2" height="4" fill="black"/><rect x="13" y="0" width="1" height="4" fill="black"/><rect x="15" y="0" width="2" height="4" fill="black"/><rect x="18" y="0" width="1" height="4" fill="black"/><rect x="21" y="0" width="1.5" height="4" fill="black"/><rect x="24" y="0" width="2" height="4" fill="black"/>
        </g>
      </g>
      <g fill="hsl(43 96% 55%)" stroke="hsl(43 90% 40%)" strokeWidth="0.6">
        <path d="M40 22 L42 28 L48 30 L42 32 L40 38 L38 32 L32 30 L38 28 Z"/>
      </g>
      <g fill="hsl(214 89% 52%)" opacity="0.85">
        <circle cx="160" cy="40" r="2"/><circle cx="170" cy="55" r="1.5"/><circle cx="155" cy="60" r="1"/>
      </g>
      <g fill="hsl(43 96% 55%)" stroke="hsl(43 90% 40%)" strokeWidth="0.5">
        <path d="M150 25 L151 28 L154 29 L151 30 L150 33 L149 30 L146 29 L149 28 Z"/>
      </g>
    </svg>
  );
}

function PostDropoffSvg() {
  return (
    <svg viewBox="0 0 220 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="h-16">
      <g stroke="hsl(214 89% 65%)" strokeWidth="2" strokeLinecap="round" opacity="0.7">
        <line x1="10" y1="55" x2="38" y2="55"/>
        <line x1="18" y1="65" x2="42" y2="65"/>
        <line x1="12" y1="75" x2="36" y2="75"/>
      </g>
      <g transform="translate(50,28)">
        <rect x="0" y="14" width="40" height="40" rx="3" fill="#214b91" stroke="#13325a" strokeWidth="1.2"/>
        <rect x="6" y="20" width="28" height="14" rx="2" fill="#bcd3f5" stroke="#13325a" strokeWidth="1"/>
        <rect x="38" y="6" width="80" height="48" rx="3" fill="white" stroke="#13325a" strokeWidth="1.2"/>
        <text x="78" y="36" textAnchor="middle" fontFamily="Inter, sans-serif" fontWeight="800" fontSize="12" fill="hsl(214 89% 52%)" letterSpacing="0.04em">SENDMO</text>
        <line x1="78" y1="6" x2="78" y2="54" stroke="#13325a" strokeWidth="0.6" strokeDasharray="2 2"/>
        <circle cx="14" cy="58" r="7" fill="#1a1a1a"/><circle cx="14" cy="58" r="3" fill="#555"/>
        <circle cx="60" cy="58" r="7" fill="#1a1a1a"/><circle cx="60" cy="58" r="3" fill="#555"/>
        <circle cx="102" cy="58" r="7" fill="#1a1a1a"/><circle cx="102" cy="58" r="3" fill="#555"/>
      </g>
      <line x1="20" y1="93" x2="200" y2="93" stroke="hsl(210 14% 70%)" strokeWidth="1" strokeDasharray="3 3"/>
    </svg>
  );
}

function PostDeliverySvg() {
  return (
    <svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="h-16">
      <ellipse cx="100" cy="86" rx="60" ry="6" fill="rgba(20,40,80,0.1)"/>
      <rect x="50" y="78" width="100" height="10" rx="2" fill="#a4cda9" stroke="#5a8a64" strokeWidth="0.8"/>
      <line x1="60" y1="83" x2="140" y2="83" stroke="#5a8a64" strokeWidth="0.6" strokeDasharray="3 3"/>
      <g transform="translate(78,30)">
        <path d="M0 18 L22 6 L22 44 L0 56 Z" fill="#c98e3e" stroke="#7d5520" strokeWidth="1.2"/>
        <path d="M0 18 L22 6 L44 18 L22 30 Z" fill="#e5b06b" stroke="#7d5520" strokeWidth="1.2"/>
        <path d="M22 30 L44 18 L44 44 L22 56 Z" fill="#b97c34" stroke="#7d5520" strokeWidth="1.2"/>
        <path d="M22 8 L22 28" stroke="#a26a26" strokeWidth="2" strokeDasharray="3 2"/>
      </g>
      <g transform="translate(124,38)">
        <circle cx="14" cy="14" r="14" fill="hsl(142 71% 45%)" stroke="white" strokeWidth="2.5"/>
        <path d="M7 14.5 L12 19 L21 9" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
      </g>
      <g fill="hsl(43 96% 55%)" stroke="hsl(43 90% 40%)" strokeWidth="0.5">
        <path d="M40 30 L41 33 L44 34 L41 35 L40 38 L39 35 L36 34 L39 33 Z"/>
        <path d="M170 50 L171 52 L173 53 L171 54 L170 56 L169 54 L167 53 L169 52 Z"/>
      </g>
      <g fill="hsl(214 89% 52%)" opacity="0.8">
        <circle cx="50" cy="46" r="1.5"/><circle cx="156" cy="32" r="1.5"/>
      </g>
    </svg>
  );
}

function DefaultHeadline({ lifecycleState }: { lifecycleState: StateHeroProps["lifecycleState"] }) {
  if (lifecycleState === "pre-dropoff") {
    return (
      <h1 className="text-[14px] font-bold tracking-tight mx-2 leading-tight">
        Your label is <span className="text-primary">ready to print</span> — waiting for drop-off!
      </h1>
    );
  }
  if (lifecycleState === "post-dropoff") {
    return (
      <h1 className="text-[14px] font-bold tracking-tight mx-2 leading-tight">
        Your package is <span className="text-amber-500">in transit!</span>
      </h1>
    );
  }
  return (
    <h1 className="text-[14px] font-bold tracking-tight mx-2 leading-tight">
      Your package was <span className="text-emerald-500">delivered!</span>
    </h1>
  );
}

export default function StateHero({ lifecycleState, headline, subtitle }: StateHeroProps) {
  return (
    <div className={cn("text-center pb-1 mb-3")}>
      <div className="h-16 flex justify-center items-end mb-1">
        {lifecycleState === "pre-dropoff" && <PreDropoffSvg />}
        {lifecycleState === "post-dropoff" && <PostDropoffSvg />}
        {lifecycleState === "post-delivery" && <PostDeliverySvg />}
      </div>

      {headline ? (
        <h1 className="text-[14px] font-bold tracking-tight mx-2 leading-tight">
          {headline}
        </h1>
      ) : (
        <DefaultHeadline lifecycleState={lifecycleState} />
      )}

      {subtitle && (
        <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
      )}
    </div>
  );
}
