Pod::Spec.new do |s|
  s.name = 'Guide'
  s.version = '1.0.0'
  s.summary = 'Bounded private provider guide ingestion and immutable local queries.'
  s.author = 'Mr. Streamer'
  s.homepage = 'https://mrstreamer.app'
  s.license = 'GPL-3.0-only'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift', 'core/*.{h,c}'
  s.public_header_files = 'core/guide_system.h'
  s.libraries = 'z', 'sqlite3'
end
