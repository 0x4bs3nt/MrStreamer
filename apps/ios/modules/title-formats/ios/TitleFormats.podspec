Pod::Spec.new do |s|
  s.name           = 'TitleFormats'
  s.version        = '1.0.0'
  s.summary        = 'Plays movie and episode files AVPlayer cannot open, as loopback HLS.'
  s.author         = 'Mr. Streamer'
  s.homepage       = 'https://mrstreamer.app'
  s.license        = 'GPL-3.0-only'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift', 'core/*.{h,c}'
  s.public_header_files = 'core/title_hls.h'
  # FFmpeg's libraries, built by scripts/build-ffmpeg.sh ios.
  s.vendored_frameworks = 'vendor/ffmpeg/libavutil.xcframework', 'vendor/ffmpeg/libavcodec.xcframework',
                          'vendor/ffmpeg/libavformat.xcframework'
  # What the app carries for FFmpeg's licence: the notice, the licence and how it was built.
  s.resource_bundles = {
    'TitleFormatsNotices' => ['vendor/ffmpeg/NOTICE.txt', 'vendor/ffmpeg/BUILD.txt',
                              'vendor/ffmpeg/COPYING.LGPLv2.1'],
  }
  s.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/vendor/ffmpeg/include"',
    'GCC_C_LANGUAGE_STANDARD' => 'c11',
  }
end
