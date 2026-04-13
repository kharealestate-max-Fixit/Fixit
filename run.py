#!/usr/bin/env python3
"""
FixIt — One-command launcher
Usage: python3 run.py
       ANTHROPIC_API_KEY=sk-ant-... python3 run.py
"""
import subprocess, sys, os, time, signal, webbrowser, threading

PORT = 3001
FRONTEND = os.path.join(os.path.dirname(__file__), "public", "index.html")
BACKEND  = os.path.join(os.path.dirname(__file__), "server", "server.py")

GREEN  = "\033[92m"
YELLOW = "\033[93m"
BLUE   = "\033[94m"
RESET  = "\033[0m"
BOLD   = "\033[1m"

def banner():
    print(f"""
{GREEN}{BOLD}
  ███████╗██╗██╗  ██╗██╗████████╗
  ██╔════╝██║╚██╗██╔╝██║╚══██╔══╝
  █████╗  ██║ ╚███╔╝ ██║   ██║   
  ██╔══╝  ██║ ██╔██╗ ██║   ██║   
  ██║     ██║██╔╝ ██╗██║   ██║   
  ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝   ╚═╝   
{RESET}{BLUE}  AI-Powered Home Repair Marketplace{RESET}
""")

def main():
    banner()
    env = os.environ.copy()

    anthropic_key = env.get("ANTHROPIC_API_KEY", "")
    stripe_key    = env.get("STRIPE_SECRET_KEY", "")

    print(f"  🤖 Claude AI:  {GREEN+'ENABLED'+RESET if anthropic_key else YELLOW+'mock mode (set ANTHROPIC_API_KEY)'+RESET}")
    print(f"  💳 Stripe:     {GREEN+'LIVE'+RESET if stripe_key else YELLOW+'simulated (set STRIPE_SECRET_KEY)'+RESET}")
    print(f"  🗄  Database:   {GREEN}SQLite (zero setup){RESET}")
    print(f"  🔌 WebSocket:  {GREEN}ws://localhost:{PORT}{RESET}")
    print()

    # Start backend
    print(f"  {GREEN}Starting backend...{RESET}")
    proc = subprocess.Popen(
        [sys.executable, BACKEND],
        env=env,
        stdout=sys.stdout,
        stderr=sys.stderr
    )

    # Wait for it to be ready
    import urllib.request
    for i in range(20):
        try:
            urllib.request.urlopen(f"http://localhost:{PORT}/api/health", timeout=1)
            break
        except:
            time.sleep(0.3)

    print()
    print(f"  {GREEN}{BOLD}✓ FixIt is running!{RESET}")
    print(f"  {BLUE}Frontend: file://{FRONTEND}{RESET}")
    print(f"  {BLUE}API:      http://localhost:{PORT}/api/health{RESET}")
    print()
    print(f"  {YELLOW}Open the frontend in your browser:{RESET}")
    print(f"  file://{FRONTEND}")
    print()
    print(f"  Press Ctrl+C to stop")
    print()

    # Try to open browser
    try:
        webbrowser.open(f"file://{FRONTEND}")
    except:
        pass

    # Keep alive
    try:
        proc.wait()
    except KeyboardInterrupt:
        print(f"\n  {YELLOW}Shutting down...{RESET}")
        proc.terminate()
        proc.wait()
        print(f"  {GREEN}Goodbye!{RESET}\n")

if __name__ == "__main__":
    main()
