
import unittest
from unittest.mock import patch, MagicMock
import json
import sys
import os

# Add exporter_node to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'exporter_node')))

from exporter import get_docker_metrics

class TestDockerMetrics(unittest.TestCase):

    @patch('os.path.exists')
    @patch('subprocess.check_output')
    def test_get_docker_metrics_success(self, mock_subprocess, mock_exists):
        # Mock socket existence
        mock_exists.return_value = True

        # Mock outputs
        # 1. Containers
        containers_json = [
            {"ID": "c1", "Image": "img1", "Status": "Up", "Names": "container1", "Size": "10MB"},
            {"ID": "c2", "Image": "img2", "Status": "Exited", "Names": "container2", "Size": "20MB"}
        ]
        output_containers = "\n".join([json.dumps(c) for c in containers_json])

        # 2. Images
        images_json = [
            {"Repository": "repo1", "Tag": "latest", "ID": "i1", "Size": "100MB"},
            {"Repository": "repo2", "Tag": "v1", "ID": "i2", "Size": "200MB"}
        ]
        output_images = "\n".join([json.dumps(i) for i in images_json])

        # 3. Summary
        summary_json = [
             {"Type": "Images", "TotalCount": 2, "Size": "300MB"},
             {"Type": "Containers", "TotalCount": 2, "Running": 1, "Size": "30MB"},
             {"Type": "Local Volumes", "TotalCount": 0, "Size": "0B"},
             {"Type": "Build Cache", "Size": "50MB"}
        ]
        output_summary = "\n".join([json.dumps(s) for s in summary_json])

        # Check_output side effects
        mock_subprocess.side_effect = [
            output_containers.encode('utf-8'),
            output_images.encode('utf-8'),
            output_summary.encode('utf-8')
        ]

        metrics = get_docker_metrics()

        self.assertIn("containers", metrics)
        self.assertEqual(len(metrics["containers"]), 2)
        self.assertEqual(metrics["containers"][0]["ID"], "c1")
        
        self.assertIn("images", metrics)
        self.assertEqual(len(metrics["images"]), 2)
        
        self.assertIn("summary", metrics)
        self.assertEqual(metrics["summary"]["Images"]["TotalCount"], 2)
        self.assertEqual(metrics["summary"]["Build Cache"]["Size"], "50MB")

    @patch('os.path.exists')
    def test_get_docker_metrics_no_socket(self, mock_exists):
        mock_exists.return_value = False
        metrics = get_docker_metrics()
        self.assertEqual(metrics, {"error": "Docker socket not found"})

if __name__ == '__main__':
    unittest.main()
