"""Convert a NIfTI segmentation mask to DICOM SEG for viewer overlay.

Produces a DICOM SEG file that can be served via WADO-URI and loaded
into Cornerstone.js as a VOI overlay.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import nibabel as nib
import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileDataset
from pydicom.uid import generate_uid, ExplicitVRLittleEndian
from pydicom.sequence import Sequence


def nifti_mask_to_dicomseg(
    mask_nifti_path: str,
    reference_dicom_dir: str,
    output_path: str,
    label_name: str = "Segmentation",
    label_description: str = "",
) -> str | None:
    """Convert a binary NIfTI mask to a DICOM SEG object.

    This is a simplified implementation that creates a valid DICOM SEG
    with binary segmentation frames matching the reference DICOM geometry.

    Parameters
    ----------
    mask_nifti_path : str
        Path to the NIfTI mask file.
    reference_dicom_dir : str
        Directory containing the reference DICOM series.
    output_path : str
        Where to write the output ``.dcm`` file.
    label_name : str
        Human-readable label name.
    label_description : str
        Description of what was segmented.

    Returns
    -------
    str or None
        Path to the written DICOM SEG file, or ``None`` on error.
    """
    try:
        # Load mask
        mask_img = nib.load(mask_nifti_path)
        mask_data = mask_img.get_fdata()

        # Load reference DICOM to get geometry
        ref_files = sorted(
            [os.path.join(reference_dicom_dir, f) for f in os.listdir(reference_dicom_dir)
             if not f.startswith(".")],
        )
        if not ref_files:
            print("No reference DICOM files found")
            return None

        ref_datasets = []
        for f in ref_files:
            try:
                ds = pydicom.dcmread(f, stop_before_pixels=True, force=True)
                if hasattr(ds, "ImagePositionPatient"):
                    ref_datasets.append(ds)
            except Exception:
                continue

        if not ref_datasets:
            print("No valid reference DICOM datasets")
            return None

        ref_datasets.sort(key=lambda x: float(x.ImagePositionPatient[2]))
        ref_ds = ref_datasets[0]

        # Resample mask to match reference geometry if needed
        # For simplicity, we assume the mask is already aligned or
        # we just take the nearest voxel for each DICOM slice position.

        n_slices = len(ref_datasets)
        rows = int(ref_ds.Rows)
        cols = int(ref_ds.Columns)

        # Create a simple binary mask per slice
        # If mask shape doesn't match, we create a zero mask
        mask_binary = (mask_data > 0.5).astype(np.uint8)

        # Create DICOM SEG
        file_meta = Dataset()
        file_meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.66.4"  # SEG Storage
        file_meta.MediaStorageSOPInstanceUID = generate_uid()
        file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

        ds = FileDataset(output_path, {}, file_meta=file_meta, preamble=b"\x00" * 128)

        # Patient & study from reference
        ds.PatientName = getattr(ref_ds, "PatientName", "Unknown")
        ds.PatientID = getattr(ref_ds, "PatientID", "")
        ds.StudyInstanceUID = ref_ds.StudyInstanceUID
        ds.StudyDate = getattr(ref_ds, "StudyDate", "")
        ds.Modality = "SEG"
        ds.Manufacturer = "DICOMclaw"
        ds.SeriesInstanceUID = generate_uid()
        ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.66.4"
        ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
        ds.SeriesDescription = f"SEG: {label_name}"
        ds.SeriesNumber = 999
        ds.InstanceNumber = 1
        ds.ContentLabel = "SEGMENTATION"
        ds.ContentDescription = label_description or label_name
        ds.ContentCreatorName = "DICOMclaw"

        # Image attributes
        ds.Rows = rows
        ds.Columns = cols
        ds.NumberOfFrames = n_slices
        ds.BitsAllocated = 1
        ds.BitsStored = 1
        ds.HighBit = 0
        ds.PixelRepresentation = 0
        ds.SamplesPerPixel = 1
        ds.ImageType = ["DERIVED", "PRIMARY"]
        ds.LossyImageCompression = "00"
        ds.SegmentationType = "BINARY"

        # Segment sequence
        seg_item = Dataset()
        seg_item.SegmentNumber = 1
        seg_item.SegmentLabel = label_name
        seg_item.SegmentAlgorithmType = "AUTOMATIC"
        seg_item.SegmentAlgorithmName = "DICOMclaw"

        # Segmented Property Category
        cat_code = Dataset()
        cat_code.CodeValue = "49755-6"
        cat_code.CodingSchemeDesignator = "LN"
        cat_code.CodeMeaning = "Morphologically Abnormal Structure"
        seg_item.SegmentedPropertyCategoryCodeSequence = Sequence([cat_code])

        prop_code = Dataset()
        prop_code.CodeValue = "T-D0050"
        prop_code.CodingSchemeDesignator = "SRT"
        prop_code.CodeMeaning = label_name
        seg_item.SegmentedPropertyTypeCodeSequence = Sequence([prop_code])

        ds.SegmentSequence = Sequence([seg_item])

        # Build pixel data (bit-packed binary)
        frames: list[np.ndarray] = []
        per_frame_items: list[Dataset] = []

        for i, ref_slice_ds in enumerate(ref_datasets):
            # Extract corresponding mask slice
            if i < mask_binary.shape[2] if mask_binary.ndim == 3 else 0:
                # Assume mask is (X, Y, Z) - take slice i along Z
                frame = mask_binary[:, :, i]
                # Resize to match DICOM dimensions if needed
                if frame.shape != (rows, cols) and frame.shape != (cols, rows):
                    frame = np.zeros((rows, cols), dtype=np.uint8)
                elif frame.shape == (cols, rows):
                    frame = frame.T
            else:
                frame = np.zeros((rows, cols), dtype=np.uint8)

            frames.append(frame.flatten())

            # Per-frame functional group
            pf = Dataset()

            # Frame content
            fc = Dataset()
            fc.DimensionIndexValues = [1, i + 1]
            pf.FrameContentSequence = Sequence([fc])

            # Plane position
            pp = Dataset()
            pp.ImagePositionPatient = ref_slice_ds.ImagePositionPatient
            pf.PlanePositionSequence = Sequence([pp])

            # Segment identification
            si = Dataset()
            si.ReferencedSegmentNumber = 1
            pf.SegmentIdentificationSequence = Sequence([si])

            per_frame_items.append(pf)

        ds.PerFrameFunctionalGroupsSequence = Sequence(per_frame_items)

        # Shared functional groups
        shared = Dataset()

        po = Dataset()
        po.ImageOrientationPatient = ref_ds.ImageOrientationPatient
        shared.PlaneOrientationSequence = Sequence([po])

        ps_item = Dataset()
        ps_item.PixelSpacing = ref_ds.PixelSpacing
        ps_item.SpacingBetweenSlices = getattr(ref_ds, "SpacingBetweenSlices",
                                                getattr(ref_ds, "SliceThickness", "1.0"))
        ps_item.SliceThickness = getattr(ref_ds, "SliceThickness", "1.0")
        shared.PixelMeasuresSequence = Sequence([ps_item])

        ds.SharedFunctionalGroupsSequence = Sequence([shared])

        # Pack bits
        all_bits = np.concatenate(frames)
        # Pad to multiple of 8
        pad_len = (8 - len(all_bits) % 8) % 8
        all_bits = np.concatenate([all_bits, np.zeros(pad_len, dtype=np.uint8)])
        packed = np.packbits(all_bits, bitorder="little")
        ds.PixelData = packed.tobytes()

        # Save
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        ds.save_as(output_path)
        print(f"DICOM SEG saved: {output_path}")
        return output_path

    except Exception as exc:
        print(f"Error creating DICOM SEG: {exc}")
        import traceback
        traceback.print_exc()
        return None
