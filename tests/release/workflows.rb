require 'yaml'

files = {
  'service' => '.github/workflows/publish-images.yml',
  'toolchain' => '.github/workflows/toolchain-images.yml'
}
files.each do |kind, file|
  document = YAML.load_file(file)
  jobs = document.fetch('jobs')
  abort "#{file}: missing build/gate/prepublish/publish" unless %w[build native-gate prepublish publish].all? { |name| jobs.key?(name) }
  abort "#{file}: native gate may start before all builds" unless jobs['native-gate']['needs'].include?('build')
  abort "#{file}: prepublish may start before gate" unless jobs['prepublish']['needs'].include?('native-gate')
  abort "#{file}: publishers may start before global prepublish" unless jobs['publish']['needs'].include?('prepublish')
  abort "#{file}: dispatch can publish" unless jobs['publish']['if'].include?("github.event_name == 'push'") && jobs['prepublish']['if'].include?("github.event_name == 'push'")
  jobs.each do |name, job|
    permissions = job.fetch('permissions', {})
    abort "#{file}: #{name} has write permissions" if name != 'publish' && permissions.values.any? { |value| value == 'write' }
  end
  abort "#{file}: publisher lacks packages write" unless jobs['publish']['permissions']['packages'] == 'write'
  publisher = jobs['publish']['steps'].to_s
  abort "#{file}: publisher rebuilds" if publisher.include?('buildx build') || publisher.include?('build-push-action')
  abort "#{file}: publisher did not load frozen artifact" unless publisher.include?('actions/download-artifact@v4') && publisher.include?('image.sh publish')
  abort "#{file}: native gate lacks exact-image script" unless jobs['native-gate']['steps'].to_s.include?('gate.sh')
  abort "#{file}: global absent-version check missing" unless jobs['prepublish']['steps'].to_s.include?('prepublish.sh')
  source = File.read(file)
  abort "#{file}: AWS or floating release reference" if source.match?(/\baws-actions\b|public\.ecr\.aws|:latest\b|:staging\b/)
  expected = kind == 'service' ? 7 : 6
  abort "#{file}: wrong image count" unless jobs['build']['strategy']['matrix']['name'].size == expected && jobs['publish']['strategy']['matrix']['name'].size == expected
end
ci = YAML.load_file('.github/workflows/image-build-check.yml')
abort 'build-only CI has publish permission' if ci.fetch('permissions').values.include?('write')
abort 'build-only CI missing native browser smoke' unless ci.fetch('jobs').key?('browser-smoke')
abort 'build-only CI missing toolchain coverage' unless ci.fetch('jobs').fetch('toolchain-build').fetch('strategy').fetch('matrix').fetch('name').size == 6
puts 'release workflow topology passed'
