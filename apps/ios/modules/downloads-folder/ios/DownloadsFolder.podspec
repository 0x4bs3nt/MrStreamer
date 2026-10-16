Pod::Spec.new do |s|
  s.name           = 'DownloadsFolder'
  s.version        = '1.0.0'
  s.summary        = 'Keeps downloaded movies and episodes out of iCloud and device backups.'
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
