use instavault_lib::instagram::{api, models::FeedResponse};
use serde_json::json;

#[test]
fn numeric_and_string_carousel_ids_are_importable() {
    let data = json!({"status":"ok","items":[{"pk":3456789012345678901u64,"media_type":8,
    "carousel_media":[
        {"pk":3456789012345678902u64,"media_type":1,"image_versions2":{"candidates":[{"url":"https://example.test/photo","width":1080,"height":1350}]}},
        {"pk":"3456789012345678903","media_type":2,"video_versions":[{"url":"https://example.test/video","width":1080,"height":1920}]}
    ]}]});
    let feed: FeedResponse = serde_json::from_value(data).unwrap();
    let media = api::extract_item(&feed.items[0], "post");
    assert_eq!(media.len(), 2);
    assert_eq!(media[1].media_type, 2);
}

#[test]
fn candidate_ties_use_bitrate_and_known_size() {
    let data = json!({"video_versions":[
        {"url":"a","width":1080,"height":1920,"bit_rate":4000,"file_size":10},
        {"url":"b","width":1080,"height":1920,"bit_rate":4000,"file_size":20}
    ]});
    assert_eq!(api::best_candidate(&data).unwrap().url, "b");
}
