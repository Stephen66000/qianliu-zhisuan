#!/usr/bin/env ruby

require "digest"
require "json"
require "yaml"

root = File.expand_path("../..", __dir__)
state_path = File.join(root, "V3", "仟流智算-stage-state-v0.3.yaml")
html_path = File.join(root, "V3", "仟流智算-Stage02开发计划进度图-v0.3.html")

state = YAML.safe_load(File.read(state_path, encoding: "UTF-8"), permitted_classes: [], aliases: false)
snapshot = {
  "source" => "V3/仟流智算-stage-state-v0.3.yaml",
  "sourceSha256" => Digest::SHA256.file(state_path).hexdigest,
  "projectName" => state.fetch("project"),
  "productVersion" => state.fetch("product_version"),
  "planVersion" => state.fetch("plan_version"),
  "updatedAt" => state.fetch("updated_at"),
  "stage01" => state.fetch("stage"),
  "stage02" => {
    "status" => state.fetch("handoff").fetch("status"),
    "reviewStatus" => state.fetch("handoff").fetch("review_status"),
    "reviewRecommendation" => state.fetch("handoff").fetch("review_recommendation"),
    "ownerDecision" => state.fetch("handoff").fetch("owner_decision"),
    "candidateLock" => state.fetch("handoff").fetch("candidate_lock")
  },
  "nextAction" => state.fetch("next_action"),
  "allowedActions" => state.fetch("allowed_actions"),
  "forbiddenActions" => state.fetch("forbidden_actions"),
  "blockers" => state.fetch("blockers"),
  "recheckTriggers" => state.fetch("recheck_triggers")
}

html = File.read(html_path, encoding: "UTF-8")
pattern = %r{(<script type="application/json" id="stage02-state-snapshot">\n).*?(\n</script>)}m
abort "stage02-state-snapshot marker missing" unless html.match?(pattern)

rendered = html.sub(pattern) do
  "#{Regexp.last_match(1)}#{JSON.pretty_generate(snapshot)}#{Regexp.last_match(2)}"
end

File.write(html_path, rendered, encoding: "UTF-8")
puts "rendered #{html_path}"
puts "source sha256 #{snapshot.fetch("sourceSha256")}"
