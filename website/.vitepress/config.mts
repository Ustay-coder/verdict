import { defineConfig } from 'vitepress';

export default defineConfig({
  "title": "Verdict",
  "description": "The evaluation engine API: decision models, human review and deterministic benchmarks.",
  "base": "/",
  "appearance": true,
  "themeConfig": {
    "nav": [
      {
        "text": "Guide",
        "link": "/guide/getting-started"
      },
      {
        "text": "API",
        "link": "/reference/rest"
      },
      {
        "text": "Rubrics",
        "link": "/reference/rubric"
      },
      {
        "text": "Providers",
        "link": "/reference/providers"
      },
      {
        "text": "GitHub",
        "link": "https://github.com/Ustay-coder/verdict"
      }
    ],
    "sidebar": [
      {
        "text": "Guide",
        "items": [
          {
            "text": "Getting started",
            "link": "/guide/getting-started"
          },
          {
            "text": "Concepts",
            "link": "/guide/concepts"
          },
          {
            "text": "Decision models",
            "link": "/guide/decision-models"
          },
          {
            "text": "Human review",
            "link": "/guide/humans"
          },
          {
            "text": "Versions, forks and CI",
            "link": "/guide/versions"
          },
          {
            "text": "Deployment",
            "link": "/guide/deploy"
          },
          {
            "text": "Agent development",
            "link": "/guide/codex"
          },
          {
            "text": "Everything Verdict does",
            "link": "/guide/overview"
          }
        ]
      },
      {
        "text": "Reference",
        "items": [
          {
            "text": "REST API",
            "link": "/reference/rest"
          },
          {
            "text": "Rubrics",
            "link": "/reference/rubric"
          },
          {
            "text": "Models and inputs",
            "link": "/reference/models"
          },
          {
            "text": "Providers",
            "link": "/reference/providers"
          },
          {
            "text": "SDK",
            "link": "/reference/sdk"
          },
          {
            "text": "CLI",
            "link": "/reference/cli"
          },
          {
            "text": "MCP",
            "link": "/reference/mcp"
          },
          {
            "text": "Configuration",
            "link": "/reference/configuration"
          }
        ]
      },
      {
        "text": "Cookbook",
        "items": [
          {
            "text": "Support ticket triage",
            "link": "/cookbook/decision-triage"
          },
          {
            "text": "Essay grading",
            "link": "/cookbook/essay-grading"
          },
          {
            "text": "Hiring debrief",
            "link": "/cookbook/human-panel"
          },
          {
            "text": "청년창업 입주심사",
            "link": "/cookbook/ko-startup-incubator"
          },
          {
            "text": "Offline release benchmark",
            "link": "/cookbook/offline-benchmark"
          },
          {
            "text": "Startup pitch review",
            "link": "/cookbook/startup-pitch"
          },
          {
            "text": "Sponsorship fit",
            "link": "/cookbook/youtube-content"
          }
        ]
      }
    ],
    "search": {
      "provider": "local"
    },
    "socialLinks": [
      {
        "icon": "github",
        "link": "https://github.com/Ustay-coder/verdict"
      }
    ]
  }
});
