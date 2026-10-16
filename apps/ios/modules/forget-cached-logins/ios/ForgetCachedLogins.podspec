Pod::Spec.new do |s|
  s.name           = 'ForgetCachedLogins'
  s.version        = '1.0.0'
  s.summary        = 'Drops the provider answers earlier builds let iOS cache under their logins.'
  s.author         = 'Mr. Streamer'
  s.homepage       = 'https://mrstreamer.app'
  s.license        = 'GPL-3.0-only'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
end
