import { createFileRoute } from "@tanstack/react-router";
import { Features } from "@/components/landing/Features";
import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Nav } from "@/components/landing/Nav";
import { Pricing } from "@/components/landing/Pricing";
import { TrustStory } from "@/components/landing/TrustStory";

export const Route = createFileRoute("/")({
    component: LandingPage,
});

function LandingPage() {
    return (
        <>
            <Nav />
            <main id="top" className="relative z-10">
                <Hero />
                <TrustStory />
                <Features />
                <HowItWorks />
                <Pricing />
                <Footer />
            </main>
        </>
    );
}
